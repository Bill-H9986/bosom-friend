import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import MediaRuntime, { MediaError, type MediaProvider } from '@deepseek-ai/dsh-media'
import { openStore } from '../src/store.ts'
import {
  MEDIA_LOG_KIND,
  appendMediaObservation,
  describeMediaObservation,
  formatBytes,
  traceMediaObservations,
} from '../src/media-trace.ts'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** 一个临时数据根上的真 store。 */
function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'bf-trace-'))
  roots.push(root)
  const store = openStore(root)
  // 账本有内容守卫：空数组不许覆盖已有文件（防"读失败→空数组→覆盖"），新根上先落一条。
  store.files.logs.save([{ date: new Date(0).toISOString(), kind: 'init', detail: '起点' }])
  return store
}

/** 一个脚本化的媒体提供方：图片成功、视频下单成功、轮询抛错。 */
function scriptedProvider(): MediaProvider {
  return {
    id: 'scripted',
    available: () => true,
    generateImage: () => Promise.resolve({ images: [{ bytes: new Uint8Array(2048), contentType: 'image/png' }], model: 'img-1' }),
    submitVideo: () => Promise.resolve({ model: 'v', jobId: 'job-9' }),
    pollVideo: () => Promise.reject(new MediaError('rejected', 'MEDIA_VENDOR_REJECTED', { status: 429 })),
  }
}

describe('媒体留痕（D3）：能力面报观察，产品记成一行账', () => {
  it('成功的图片生成记下路由、模型、耗时、输入与产出', async () => {
    const store = makeStore()
    const ctx = new Context()
    const fiber = await ctx.plugin(MediaRuntime)
    ctx.media.registerProvider(scriptedProvider())
    traceMediaObservations(ctx, store.files)
    await ctx.media.generateImage({ provider: 'bf-agnes-builtin', model: 'agnes-image-2.5-flash', prompt: '面霜主图', count: 1, resolution: '1K' })
    const entry = store.files.logs.load()[0]
    expect(entry?.kind).toBe(MEDIA_LOG_KIND)
    expect(entry?.detail).toContain('图片生成')
    expect(entry?.detail).toContain('成功')
    expect(entry?.detail).toContain('bf-agnes-builtin')
    expect(entry?.detail).toContain('agnes-image-2.5-flash')
    expect(entry?.detail).toContain('输入 4 字')
    expect(entry?.detail).toContain('产出 2.0 KB')
    expect(entry?.detail, '时间戳是账本行的一部分').toMatch(/\d+ms/)
    await fiber.dispose()
  })

  it('失败的调用同样留痕：分类与厂商状态码都在（复盘时要能对上）', async () => {
    const store = makeStore()
    const ctx = new Context()
    const fiber = await ctx.plugin(MediaRuntime)
    ctx.media.registerProvider(scriptedProvider())
    traceMediaObservations(ctx, store.files)
    await expect(ctx.media.pollVideo({ provider: 'bf-voice', model: 'v-1', jobId: 'job-9' })).rejects.toThrow()
    const entry = store.files.logs.load()[0]
    expect(entry?.detail).toContain('视频轮询')
    expect(entry?.detail).toContain('MEDIA_VENDOR_REJECTED')
    expect(entry?.detail).toContain('HTTP 429')
    await fiber.dispose()
  })

  it('账本写不进去只报不改：一次成功的媒体调用不许因此变成失败', async () => {
    const files = makeStore().files
    files.logs.load = () => { throw new Error('磁盘满') }
    expect(() => appendMediaObservation(files, {
      operation: 'generateImage', provider: 'r', model: 'm', durationMs: 1, ok: true,
      input: { textChars: 0, imageCount: 0, audioCount: 0 },
    })).toThrow()
    // 订阅这一层把它吞掉并留日志：能力面的调用结果不受影响（下面的断言在 ctx 上验）。
    const store = makeStore()
    const ctx = new Context()
    const fiber = await ctx.plugin(MediaRuntime)
    ctx.media.registerProvider(scriptedProvider())
    store.files.logs.save = () => { throw new Error('磁盘满') }
    traceMediaObservations(ctx, store.files)
    const result = await ctx.media.generateImage({ provider: 'r', model: 'm', prompt: 'x' })
    expect(result.images).toHaveLength(1)
    await fiber.dispose()
  })

  it('格式与描述是纯函数：字节大小分级、未知分类如实写', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(describeMediaObservation({
      operation: 'submitVideo', provider: 'r', model: 'm', durationMs: 12, ok: false,
      input: { textChars: 0, imageCount: 2, audioCount: 1, durationSeconds: 5 },
    })).toBe('视频下单 · 失败（未分类） · 路由 r · 模型 m · 12ms · 参考图 2 张 · 参考音 1 段 · 时长 5s')
  })
})
