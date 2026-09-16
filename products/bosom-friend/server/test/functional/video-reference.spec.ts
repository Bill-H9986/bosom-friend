import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agnesVideoModeFields } from '../../src/api.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 图生视频：用户选中的参考图必须真的进到厂商请求里。
 *
 * 这条链路以前是断的——`request.imageUrls` 只落盘留痕，媒体生成全程没读过它，
 * 于是"用图片生成视频"实际走的是文生视频，成品和用户那张图没有任何关系。
 * 这里用真实 HTTP 形状（OpenAI 兼容端点 404 → Agnes 异步 /videos + /agnesapi 轮询）
 * 把厂商请求截下来，断言参考图确实以首帧身份发出，且成片落盘可播。
 */
let h: Harness

/** 参考图字节：厂商拿到的是 Data URI，用可辨识的内容断言"发出去的就是这张"。 */
const REFERENCE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const REFERENCE_URL = '/bosom-friend/api/assets/file/asset-ref-under-test.png'
const VIDEO_BYTES = Buffer.from('fake-mp4-bytes-for-download-test')

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

/** 厂商侧收到的请求（创建视频任务与生成图片都要记，用于断言"有没有多余调用"）。 */
let captured: CapturedRequest[] = []

/**
 * 真实形状的厂商桩：通用视频端点 404、Agnes 创建任务 200、轮询一次即 completed、
 * 图片端点回 b64、成品可下载。
 */
function vendorFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    captured.push({ url, body })
    if (url.endsWith('/videos/generations'))
      return new Response('{"error":"not found"}', { status: 404 })
    if (url.endsWith('/videos'))
      return new Response(JSON.stringify({ id: 'task_x', video_id: 'video_x', status: 'queued' }), { status: 200 })
    if (url.endsWith('/images/generations'))
      return new Response(JSON.stringify({ data: [{ b64_json: REFERENCE_PNG.toString('base64') }] }), { status: 200 })
    if (url.includes('/agnesapi?')) {
      return new Response(JSON.stringify({
        status: 'completed',
        metadata: { url: 'https://cdn.example.com/out.mp4' },
      }), { status: 200 })
    }
    if (url === 'https://cdn.example.com/out.mp4')
      return new Response(VIDEO_BYTES, { status: 200 })
    return new Response('{"error":"unexpected url"}', { status: 500 })
  }) as typeof fetch
}

/** 写入模型配置：视频通道必配，图片通道按用例需要。 */
async function configureModels(options: { image?: boolean } = {}): Promise<void> {
  const saved = await h.call('PUT', 'ai/user-llm', {
    body: {
      providers: [{
        id: 'media',
        displayName: '媒体网关',
        baseUrl: 'https://media.example.com/v1',
        apiKey: 'sk-media-probe',
        models: ['agnes-video-2.5-flash', 'agnes-image-2.5-flash'],
      }],
      activeProviderId: 'media',
      video: { providerId: 'media', model: 'agnes-video-2.5-flash' },
      ...(options.image === true ? { image: { providerId: 'media', model: 'agnes-image-2.5-flash' } } : {}),
    },
  })
  expect(saved.code, '媒体模型必须先配置好，否则走不到厂商请求').toBe(0)
}

/** 轮询生成任务直到终态；超时返回最后一次读到的记录。 */
async function waitForGeneration(id: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const list = h.disk<Array<{ id: string, status: string, response?: { videoUrl?: string, imageUrls?: string[] }, errorMessage?: string }>>('draft-generations.json')
    const gen = list.find(item => item.id === id)
    if (gen !== undefined && (gen.status === 'success' || gen.status === 'failed' || gen.status === 'partial'))
      return gen
    if (Date.now() > deadline)
      return gen
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** 发一次视频生成请求并等它收尾。 */
async function generateVideo(body: Record<string, unknown>) {
  const created = await h.call<{ taskIds: string[] }>('POST', 'ai/draft-generation/v2', {
    // duration 60 走本地长视频分镜模板，不触发内核 LLM 调用，媒体生成照跑。
    body: { quantity: 1, groupId: 'mg-persist', model: 'zy-template-video', duration: 60, resolution: '720p', aspectRatio: '9:16', ...body },
  })
  expect(created.code).toBe(0)
  return waitForGeneration(created.data.taskIds[0]!)
}

beforeAll(() => {
  h = createHarness()
  mkdirSync(join(h.dataRoot, 'uploads'), { recursive: true })
  writeFileSync(join(h.dataRoot, 'uploads', 'asset-ref-under-test.png'), REFERENCE_PNG)
})
afterEach(() => {
  vi.unstubAllGlobals()
  captured = []
})

describe('图生视频：参考图必须进到厂商请求里', () => {
  it('单个参考图按首帧发出（Data URI），成片落盘为可播放文件', async () => {
    await configureModels()
    vi.stubGlobal('fetch', vendorFetch())

    const gen = await generateVideo({
      prompt: '让这张产品图里的机器缓慢转动，镜头轻微推进',
      imageUrls: [REFERENCE_URL],
    })

    expect(gen?.status, '图生视频必须成功收尾：' + String(gen?.errorMessage)).toBe('success')
    expect(gen?.response?.videoUrl, '厂商成片必须落盘成可播放文件').toBeTruthy()
    expect(gen?.response?.imageUrls, '图生视频的媒体就是用户给的图，不再另生成图片').toEqual([REFERENCE_URL])

    const createCalls = captured.filter(item => item.url.endsWith('/videos'))
    expect(createCalls.length, '必须真的调用过厂商创建任务接口').toBeGreaterThan(0)
    const payload = createCalls[createCalls.length - 1]!.body
    expect(payload.mode, '单图走首帧模式').toBe('keyframe')
    const firstFrame = String(payload.first_frame ?? '')
    expect(firstFrame.startsWith('data:image/png;base64,'), '本地图必须以 Data URI 内联：' + firstFrame.slice(0, 40)).toBe(true)
    expect(firstFrame.slice('data:image/png;base64,'.length), '发出去的必须是用户那张图的字节').toBe(REFERENCE_PNG.toString('base64'))
    expect(payload.prompt, '提示词照常下发').toBeTruthy()
  }, 60_000)

  it('没有参考图时不带任何图片字段，保持纯文生视频', async () => {
    await configureModels({ image: true })
    vi.stubGlobal('fetch', vendorFetch())

    const gen = await generateVideo({ prompt: '城市夜景延时摄影' })
    expect(gen?.status, '纯文生视频必须成功收尾：' + String(gen?.errorMessage)).toBe('success')

    const createCalls = captured.filter(item => item.url.endsWith('/videos'))
    expect(createCalls.length, '必须真的调用过厂商创建任务接口').toBeGreaterThan(0)
    const payload = createCalls[createCalls.length - 1]!.body
    expect(payload.mode).toBe('text')
    expect(payload.first_frame, '纯文生视频不得带首帧字段').toBeUndefined()
    expect(payload.images, '纯文生视频不得带参考图字段').toBeUndefined()
  }, 60_000)
})

describe('Agnes 模式选择：按引用图张数落到对应模式', () => {
  it('0/1/2/3 张图分别落到 text / keyframe 首帧 / keyframe 首尾帧 / reference', () => {
    expect(agnesVideoModeFields([])).toEqual({ mode: 'text' })
    expect(agnesVideoModeFields(['a'])).toEqual({ mode: 'keyframe', first_frame: 'a' })
    expect(agnesVideoModeFields(['a', 'b'])).toEqual({ mode: 'keyframe', first_frame: 'a', last_frame: 'b' })
    expect(agnesVideoModeFields(['a', 'b', 'c'])).toEqual({ mode: 'reference', images: ['a', 'b', 'c'] })
  })

  it('参考图超过厂商上限时截断到 5 张，不把必然 400 的请求发出去', () => {
    const fields = agnesVideoModeFields(['1', '2', '3', '4', '5', '6', '7'])
    expect(fields.mode).toBe('reference')
    expect(fields.images).toEqual(['1', '2', '3', '4', '5'])
  })
})
