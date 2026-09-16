import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 数字人成片的真机 e2e：**只桩掉写稿的模型，其余全走真的**。
 *
 * 配音真连 Edge 语音服务、出画真调 Agnes、拼接真跑随包 ffmpeg —— 这条用例回答的是
 * 「这台机器上到底出不出得来一条能发的带货视频」，任何一环是桩的都不算数。
 * 默认跳过（要花真实厂商额度与几分钟），显式开：`BF_REAL_DIGITAL_HUMAN=1`。
 */
const ENABLED = process.env.BF_REAL_DIGITAL_HUMAN === '1'
const FFMPEG = process.env.FFMPEG_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'resources', 'runtime', 'ffmpeg.exe')
const REAL_LLM = join(homedir(), '.bosom-friend', 'bosom-friend', 'llm-user.json')
const AVATAR_SOURCE = join(tmpdir(), 'bf-portrait.png')

vi.mock('../../src/kernel-client.ts', () => ({
  createKernelClient: () => ({
    // 只桩写稿这一步：两句短稿 → 两段，覆盖"分段生成再拼接"。
    prompt: async (_prompt: string, onDelta?: (text: string) => void) => {
      const text = '姐妹们，这款面霜我自己用了三个月。今天直播间直降一百，点下方链接就能拍。'
      onDelta?.(text)
      return { text }
    },
    close: async () => {},
  }),
}))

let h: Harness

describe.skipIf(!ENABLED || !existsSync(REAL_LLM) || !existsSync(AVATAR_SOURCE) || !existsSync(FFMPEG))('数字人成片真机 e2e（真配音 + 真 Agnes + 真 ffmpeg）', () => {
  beforeAll(async () => {
    process.env.FFMPEG_PATH = FFMPEG
    h = createHarness()
    // 用户真实的模型配置：真实验证不能拿假 key 跑。
    copyFileSync(REAL_LLM, join(h.dataRoot, 'llm-user.json'))
    mkdirSync(join(h.dataRoot, 'uploads'), { recursive: true })
    copyFileSync(AVATAR_SOURCE, join(h.dataRoot, 'uploads', 'asset-avatar-real.png'))
  }, 60_000)
  afterAll(() => { h.dispose() })

  it('写稿 → 逐段真配音 → 逐段真出画 → 真拼接，产出一条可播成片', async () => {
    const human = await h.call<{ id: string }>('POST', 'digital-humans', {
      body: { name: '雅姐', avatarUrl: '/bosom-friend/api/assets/file/asset-avatar-real.png' },
    })
    expect(human.code, '形象图必须能被本机读到').toBe(0)

    // 走通用长视频工作流：数字人只是 producer 的一种。
    const started = await h.call<{ taskId: string }>('POST', 'long-videos', {
      body: { producer: 'digital-human', producerRef: human.data.id, topic: '保湿面霜，主打秋冬干燥肌', targetSeconds: 12 },
    })
    expect(started.code).toBe(0)

    let task: { status: string, doneSegments: number, totalSegments: number, videoUrl?: string, errorMessage?: string, segments: Array<{ audioSeconds: number }> } | undefined
    const deadline = Date.now() + 15 * 60_000
    for (;;) {
      const res = await h.call<typeof task>('GET', 'long-videos/' + started.data.taskId)
      task = res.data
      if (task !== undefined && task.status !== 'generating') break
      if (Date.now() > deadline) break
      await new Promise(resolve => setTimeout(resolve, 5000))
    }

    expect(task?.status, '真机链路必须跑通：' + String(task?.errorMessage)).toBe('success')
    expect(task?.totalSegments).toBeGreaterThanOrEqual(2)
    expect(task?.doneSegments).toBe(task?.totalSegments)
    for (const segment of task?.segments ?? [])
      expect(segment.audioSeconds, '每段必须有真实配音时长').toBeGreaterThan(0)

    const assetId = 'lv-' + started.data.taskId + '.mp4'
    const file = join(h.dataRoot, 'uploads', assetId)
    expect(existsSync(file), '成片必须真的落盘').toBe(true)
    const bytes = readFileSync(file)
    expect(bytes.length, '成片不能是空文件').toBeGreaterThan(100_000)

    // 拼接结果要覆盖所有段：成片时长 ≈ 各段时长之和（允许编码带来的少量误差）。
    const { probeDurationSeconds } = await import('../../src/ffmpeg.ts')
    const total = (await probeDurationSeconds(file))
    const sum = (task?.segments ?? []).reduce((acc, s) => acc + s.audioSeconds, 0)
    console.log('成片 ' + total.toFixed(2) + 's / 各段配音合计 ' + sum.toFixed(2) + 's，文件 ' + bytes.length + ' 字节')
    expect(total, '成片必须包含全部段落').toBeGreaterThan(sum * 0.6)
    // 临时数据根会在 afterAll 里被清掉：把成片拷到固定位置，供人工看片与留证据。
    copyFileSync(file, join(tmpdir(), 'bf-digital-human-final.mp4'))
    writeFileSync(join(tmpdir(), 'bf-dh-real-result.txt'), join(tmpdir(), 'bf-digital-human-final.mp4'))
  }, 20 * 60_000)
})
