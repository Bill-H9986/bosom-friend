import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

/**
 * 写稿与分镜都经内核模型客户端：这一组用例验的是"参考图有没有真的进到厂商请求里"，
 * 所以把内核桩起来（真实内核要另起运行时，跑不进单测）。桩只回一段够字数的口播稿。
 */
vi.mock('../../src/kernel-client.ts', async () => ({
  // 上下文两个助手用真实实现：mock 掉内核不等于可以把它们也换成空实现。
  ...(({ chatTranscript, chatSessionId }) => ({ chatTranscript, chatSessionId }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  ),
  createKernelClient: () => ({
    prompt: async (prompt: string, onDelta?: (text: string) => void) => {
      // 写稿闸门按"目标时长 × 产品语速"折算字数并硬校验：桩必须给够字（10 秒档约 45 字）。
      const script = '秋冬保湿面霜主打干皮救急，今晚直播间直降一百，点下方链接就能拍，库存有限别错过。'
        + '它是那种厚实但不闷的质地，晚上洗完脸涂一层，第二天早上摸着还是软的，上妆也不卡粉。'
      const text = prompt.includes('只输出 JSON')
        ? JSON.stringify({ shots: [{ kind: 'talking-head', seconds: 5, line: script.slice(0, 20) }] })
        : script
      onDelta?.(text)
      return { text }
    },
    close: async () => {},
  }),
}))

/** 参考图字节：厂商拿到的是 Data URI，用可辨识的内容断言"发出去的就是这张"。 */
const REFERENCE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const REFERENCE_URL = '/bosom-friend/api/assets/file/asset-ref-under-test.png'
/**
 * 厂商"成片"的字节：必须是**真能解码的 MP4**。
 *
 * 这里踩过一次：原先塞的是 'fake-mp4-bytes…' 字符串，拼接步骤用真 ffmpeg 打不开，
 * 于是整条生成按设计降级成"图片轮播"，用例判红看着像功能坏了——实际是夹具不合法
 * （实测报错：Invalid data found when processing input）。
 * 用本机 ffmpeg 现造 1 秒竖屏片段，既小又真。
 */
let videoBytes: Buffer = Buffer.from('')
// 本文件在 server/test/functional/ 下：上溯三层到 products/bosom-friend 才是产品根。
const FFMPEG = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), 'desktop', 'dist', 'runtime', 'ffmpeg.exe')

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
      return new Response(videoBytes, { status: 200 })
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
async function waitForGeneration(id: string, timeoutMs = 90_000) {
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
    // duration 10：这一组用例验的是**单片**路径（参考图 → 厂商首帧/参考模式），走的是 ≤12 秒那一句。
    // >12 秒（半分钟 / 一分钟档）改走分段工作流，那条链路由 long-video.spec.ts 覆盖。
    // model 必须是**厂商模型**：选了本地模板（zy-template-video）就只走本地幻灯片，不调厂商。
    body: { quantity: 1, groupId: 'mg-persist', model: 'agnes-video-2.5-flash', duration: 10, resolution: '720p', aspectRatio: '9:16', ...body },
  })
  expect(created.code).toBe(0)
  return waitForGeneration(created.data.taskIds[0]!)
}

/** 造一段真能解码的竖屏 MP4（带音轨），给厂商下载响应当字节。 */
function makeVendorMp4(): Buffer {
  const file = join(tmpdir(), 'bf-vendor-stub-' + String(process.pid) + '.mp4')
  const probe = spawnSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=24:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ])
  if (probe.status !== 0) throw new Error('夹具需要本机 ffmpeg 造一段真 MP4：' + String(probe.stderr))
  return readFileSync(file)
}

beforeAll(() => {
  // 媒体走真实的 Provider（dsh-media-pi-ai 的工厂），厂商由本文件的 fetch 桩顶上；
  // 路由 id 与用例写进配置的服务 id（media）一致。
  h = createHarness({ media: [{ providerId: 'media', baseURL: 'https://media.example.com/v1', api: 'agnes' }] })
  mkdirSync(join(h.dataRoot, 'uploads'), { recursive: true })
  writeFileSync(join(h.dataRoot, 'uploads', 'asset-ref-under-test.png'), REFERENCE_PNG)
  videoBytes = makeVendorMp4()
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
  }, 150_000)

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
  }, 150_000)

  it('请求里带一个没在设置里配过的型号：如实拒绝，绝不拿它下单', async () => {
    await configureModels()
    vi.stubGlobal('fetch', vendorFetch())
    // 典型来源：前端缓存里的旧选择（换了配置之后没刷新）。产品只用设置里配的型号，
    // 拿一个用户没配过的名字去下单，等于替他改了配置——他只会从成片和账单上发现。
    await generateVideo({ prompt: '城市夜景延时摄影', model: 'some-other-video-model' })
    expect(captured.filter(item => item.url.endsWith('/videos')), '不得向厂商下单').toHaveLength(0)
  }, 60_000)
})
