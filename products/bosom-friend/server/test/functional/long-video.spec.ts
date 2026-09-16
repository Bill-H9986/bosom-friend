import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agnesTalkingHeadFields } from '../../src/api.ts'
import {
  clampSegmentSeconds,
  estimateSeconds,
  minScriptChars,
  normalizeSpokenText,
  planSegmentCount,
  splitScript,
} from '../../src/long-video.ts'
import { MIN_PRODUCT_SHOTS } from '../../src/storyboard.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 长视频产出通用工作流：切段口径 + 同一条编排挂不同片段生成器。
 *
 * 这条产品线只有一条编排（写稿 → 切段 → 逐段生成 → 拼接），业务差别全在片段生成器：
 * 数字人口播（固定形象 + 配音）与场景呈现（不出镜、每段一个画面）走的是同一套代码。
 * 这里把两件事都钉住——切段的边界，以及"换生成器不改编排"。
 */
vi.mock('../../src/kernel-client.ts', () => ({
  createKernelClient: () => ({
    // 稿件与增强结果都由模型写：桩成两句，正好覆盖"多段拼接"这条路径。
    // modelScripts 是每个用例自己的答题脚本（按调用顺序取，用完继续用最后一条），
    // 让"写短了要补写""增强只认模型原文"这类口径能在同一个桩上分别验证。
    prompt: async (prompt: string, onDelta?: (text: string) => void) => {
      modelPrompts.push(prompt)
      // 分镜那一次要求"输出 JSON"：夹具存在就返回分镜表，否则返回普通脚本（触发确定性兜底）。
      const text = prompt.includes('只输出 JSON') && modelShotPlan !== ''
        ? modelShotPlan
        : (modelScripts.length > 1 ? modelScripts.shift()! : (modelScripts[0] ?? ''))
      onDelta?.(text)
      return { text }
    },
    close: async () => {},
  }),
}))

// 配音不在功能用例的验证范围（要连微软在线服务）：桩掉它，只留编排与接口本身。
vi.mock('../../src/tts.ts', async () => {
  const { writeFileSync } = await import('node:fs')
  return {
    synthesizeSpeech: async (text: string, voice: string, outFile: string, options?: { probeDuration?: boolean }) => {
      ttsCalls.push({ text, voice, probeDuration: options?.probeDuration })
      writeFileSync(outFile, Buffer.from('fake-mp3:' + text.slice(0, 8)))
      return { ok: true as const, result: { file: outFile, seconds: options?.probeDuration === false ? 0 : 6 } }
    },
  }
})

// 拼接要真 ffmpeg；编排用例里桩成"按顺序拼字节"，真拼接由 video-compose.spec.ts 覆盖。
// 但拼接参数要记下来：字幕有没有真的交到拼接这一步，只有在这里才看得见。
vi.mock('../../src/video-compose.ts', async () => {
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  return {
    composeSegments: async (options: { segments: string[], outFile: string }) => {
      composeCalls.push(options)
      mkdirSync(dirname(options.outFile), { recursive: true })
      writeFileSync(options.outFile, Buffer.concat(options.segments.map(file => readFileSync(file))))
      return { ok: true as const, file: options.outFile }
    },
  }
})

let h: Harness
const AVATAR_URL = '/bosom-friend/api/assets/file/asset-avatar-under-test.png'
/** 可选的产品参考图（与形象图同样落盘在 uploads 里，由 beforeAll 写入）。 */
const PRODUCT_URL = '/bosom-friend/api/assets/file/asset-product-under-test.png'
const SEGMENT_BYTES = Buffer.from('fake-mp4-segment')
/** 明显短于目标时长的稿子：31 字只值约 7 秒，远不足 12 秒的折算下限（54 字）。 */
const SHORT_SCRIPT = '姐妹们注意了，这款产品我自己用了三个月，真的离不开它。'
/** 同一句话补上一个卖点：63 字够了 12 秒，多段与"不补写"两条路径都用它。 */
const LONG_SCRIPT = SHORT_SCRIPT + '今天直播间直降一百，点下方链接就能拍，库存有限别错过。'
/** 模型答题脚本；末尾那条会被重复使用，until 用例自己改写。 */
let modelScripts: string[] = [SHORT_SCRIPT]
/** 分镜夹具：设了它，"导演"那次调用就返回这张分镜表（用于验证执行链路真按分镜跑）。 */
let modelShotPlan = ''
/** 模型收到的完整提示词，用于断言要求确实写进了提示词而不是只存在于类型里。 */
let modelPrompts: string[] = []
/** 配音调用记录：试听与分段生成对时长探测的要求不同，只有这里看得见。 */
let ttsCalls: Array<{ text: string, voice: string, probeDuration?: boolean }> = []

/** 厂商侧收到的创建任务请求。 */
let captured: Array<Record<string, unknown>> = []
/** 交给拼接的参数（用于断言字幕确实被传下去了）。 */
let composeCalls: Array<Record<string, unknown>> = []

/** 真实形状的厂商桩：创建任务 200、轮询一次 completed、成片可下载。 */
function vendorFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    // Agnes 没有 OpenAI 兼容的 /videos/generations（真实返回 404，不触发重试）；返回 500 会白白重试 19 秒。
    if (url.endsWith('/videos/generations'))
      return new Response('{"error":"not found"}', { status: 404 })
    if (url.endsWith('/videos')) {
      captured.push(typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {})
      return new Response(JSON.stringify({ id: 't', video_id: 'v', status: 'queued' }), { status: 200 })
    }
    if (url.includes('/agnesapi?'))
      return new Response(JSON.stringify({ status: 'completed', metadata: { url: 'https://cdn.example.com/seg.mp4' } }), { status: 200 })
    if (url === 'https://cdn.example.com/seg.mp4')
      return new Response(SEGMENT_BYTES, { status: 200 })
    return new Response('{"error":"unexpected"}', { status: 500 })
  }) as typeof fetch
}

/** 起任务时允许覆盖的字段（新增入参要在这里显式转发，否则测试看起来"参数没生效"）。 */
interface StartTaskBody extends Record<string, unknown> {
  producer: string
  topic: string
  targetSeconds?: number
  producerRef?: string
  productImageUrl?: string
}

interface TaskView {
  status: string
  doneSegments: number
  totalSegments: number
  videoUrl?: string
  errorMessage?: string
  producer: string
  segments: Array<{ text: string, audioSeconds: number }>
  /** 分镜表：逐镜类型与终态（验证"按分镜跑"要看它）。 */
  shots?: Array<{ kind: string, line: string, status: string, seconds: number, visual: string }>
  scriptChars?: number
}

/** 轮询任务直到终态。 */
// 60 秒：整包并发跑时（多个套件同时开）本用例实测会被 CPU 挤到 30 秒外，
// 那是环境慢，不是产品失败——门禁里出现过这种假红。
async function waitForTask(id: string, timeoutMs = 60_000): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await h.call<TaskView>('GET', 'long-videos/' + id)
    if (res.data.status !== 'generating') return res.data
    if (Date.now() > deadline) return res.data
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** 起一条长视频任务：body 原样透传（新增入参不必改这里）。 */
async function startTask(body: StartTaskBody): Promise<TaskView> {
  const started = await h.call<{ taskId: string }>('POST', 'long-videos', { body })
  expect(started.code, '任务必须建得起来').toBe(0)
  return waitForTask(started.data.taskId)
}

beforeAll(async () => {
  h = createHarness()
  mkdirSync(join(h.dataRoot, 'uploads'), { recursive: true })
  writeFileSync(join(h.dataRoot, 'uploads', 'asset-avatar-under-test.png'), Buffer.from('fake-avatar-png'))
  // 产品图必须是一张**真 PNG**：内联进厂商请求时会按图片读字节，假字节会被判为"读不出来"而丢弃，
  // 那样测试看起来"参数没生效"，其实是被正确拒绝了。1x1 透明 PNG。
  writeFileSync(join(h.dataRoot, 'uploads', 'asset-product-under-test.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9pQAAAAASUVORK5CYII=',
    'base64',
  ))
  await h.call('PUT', 'ai/user-llm', {
    body: {
      providers: [{ id: 'v', displayName: 'V', baseUrl: 'https://media.example.com/v1', apiKey: 'sk-x', models: ['agnes-video-2.5-flash'] }],
      activeProviderId: 'v',
      video: { providerId: 'v', model: 'agnes-video-2.5-flash' },
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  captured = []
  composeCalls = []
  modelScripts = [SHORT_SCRIPT]
  modelShotPlan = ''
  modelPrompts = []
  ttsCalls = []
})

describe('稿件切段：边界由厂商 4~12 秒的硬约束反推', () => {
  it('相邻短句合并到 ≥4 秒，不会出现"一次生成只念半句"', () => {
    const segments = splitScript('大家好。今天推荐一款好物。')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toContain('大家好')
    expect(segments[0]).toContain('好物')
  })

  it('任何一段都不超过 12 秒（超了厂商直接拒收）', () => {
    for (const segment of splitScript('这是一句特别长的口播文案'.repeat(20)))
      expect(segment.length).toBeLessThanOrEqual(Math.floor(12 * 4.5) + 1)
  })

  it('清掉 Markdown、话题标签与多余空白，只留能念的字', () => {
    expect(normalizeSpokenText('## 标题\n**正文** #带货 #好物\n\n更多内容')).toBe('标题 正文 更多内容')
    expect(splitScript('   ')).toEqual([])
  })

  it('时长夹到厂商接受的 4~12 秒区间', () => {
    expect(clampSegmentSeconds(1)).toBe(4)
    expect(clampSegmentSeconds(9)).toBe(9)
    expect(clampSegmentSeconds(60)).toBe(12)
    expect(clampSegmentSeconds(Number.NaN)).toBe(12)
  })
})

describe('稿件长度校准：目标秒数先折算成字数，再要求模型写够', () => {
  it('目标时长折算成段数与字数下限', () => {
    expect(planSegmentCount(8)).toBe(1)
    expect(planSegmentCount(12)).toBe(1)
    expect(planSegmentCount(13)).toBe(2)
    expect(planSegmentCount(30)).toBe(3)
    expect(planSegmentCount(120)).toBe(10)
    expect(minScriptChars(30)).toBe(135)
    // 折算与切段共用同一把尺子：估算出的秒数必须等于按字数反推的秒数。
    const line = '这款面霜主打干皮救急'
    expect(estimateSeconds(line)).toBe(Math.round(line.length / 4.5))
  })

  it('写短了的稿子会补写一次（并把补写要求写进提示词），够长就不补', async () => {
    vi.stubGlobal('fetch', vendorFetch())
    expect(SHORT_SCRIPT.length, '这一稿必须真的短于 12 秒的折算字数').toBeLessThan(minScriptChars(12))
    expect(LONG_SCRIPT.length, '这一稿必须真的够 12 秒').toBeGreaterThanOrEqual(minScriptChars(12))
    modelScripts = [SHORT_SCRIPT, LONG_SCRIPT]
    const task = await startTask({ producer: 'scene', topic: '干皮救急面霜', targetSeconds: 12 })
    expect(task.status, String(task.errorMessage)).toBe('success')

    const writes = modelPrompts.filter(prompt => prompt.includes('你是短视频编剧'))
    expect(writes.length, '短稿必须触发一次补写').toBe(2)
    expect(writes[0], '第一次要把字数下限写进提示词').toContain('不少于 ' + String(minScriptChars(12)) + ' 字')
    expect(writes[1]).toContain('上一稿只有 ' + String(SHORT_SCRIPT.length) + ' 字')
    expect(task.scriptChars, '稿件真实字数要落盘，生成记录里看得到').toBe(LONG_SCRIPT.length)
    expect(task.scriptText).toBe(LONG_SCRIPT)
    // 目标 24 秒、单段上限 12 秒：写足了就该有多段，而不是被切成 1 段凑合。
    expect(task.totalSegments).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('稿子本来够长就不补写（不做无谓的第二次模型调用）', async () => {
    vi.stubGlobal('fetch', vendorFetch())
    modelScripts = [LONG_SCRIPT]
    const task = await startTask({ producer: 'scene', topic: '加绒保暖内衣', targetSeconds: 12 })
    expect(task.status, String(task.errorMessage)).toBe('success')
    expect(modelPrompts.filter(prompt => prompt.includes('你是短视频编剧'))).toHaveLength(1)
  }, 60_000)
})

describe('片段生成器契约：口播参数按内容形式选择', () => {
  it('数字人口播走 reference 模式，带上形象图、音频与固定种子', () => {
    expect(agnesTalkingHeadFields({ images: ['a'], audios: ['b'], seed: 7 }))
      .toEqual({ mode: 'reference', images: ['a'], audios: ['b'], seed: 7 })
    // 厂商上限：Flash 图片 ≤5、音频 ≤3，超出按前几张截断而不是发一个必然 400 的请求。
    expect(agnesTalkingHeadFields({ images: ['1', '2', '3', '4', '5', '6'], audios: ['a', 'b', 'c', 'd'], seed: 1 }).images)
      .toEqual(['1', '2', '3', '4', '5'])
    expect(agnesTalkingHeadFields({ images: ['1'], audios: ['a', 'b', 'c', 'd'], seed: 1 }).audios)
      .toEqual(['a', 'b', 'c'])
  })
})

describe('数字人形象库：producer=digital-human 的可选项', () => {
  it('没名字或没形象图一律拒绝，不落一条用不了的记录', async () => {
    expect((await h.call('POST', 'digital-humans', { body: { avatarUrl: AVATAR_URL } })).code).not.toBe(0)
    expect((await h.call('POST', 'digital-humans', { body: { name: '雅姐' } })).code).not.toBe(0)
    expect((await h.call('POST', 'digital-humans', { body: { name: '雅姐', avatarUrl: '/bosom-friend/api/assets/file/nope.png' } })).code, '形象图读不出来必须当场拒绝').not.toBe(0)
    expect((await h.call<{ list: unknown[] }>('GET', 'digital-humans')).data.list, '被拒的请求不得留下记录').toHaveLength(0)
  })

  it('创建后可读回，音色缺省用默认值，删除后列表为空', async () => {
    const created = await h.call<{ id: string, voice: string, seed: number }>('POST', 'digital-humans', {
      body: { name: '雅姐', avatarUrl: AVATAR_URL },
    })
    expect(created.code).toBe(0)
    expect(created.data.voice).toBe('zh-CN-XiaoxiaoNeural')
    expect(Number.isInteger(created.data.seed), '固定种子必须落盘，否则跨次形象不稳').toBe(true)
    expect((await h.call<{ list: unknown[] }>('GET', 'digital-humans')).data.list).toHaveLength(1)
    expect((await h.call('DELETE', 'digital-humans/' + created.data.id)).code).toBe(0)
    expect((await h.call<{ list: unknown[] }>('GET', 'digital-humans')).data.list).toHaveLength(0)
    expect((await h.call('DELETE', 'digital-humans/' + created.data.id)).code, '重复删除如实报不存在').not.toBe(0)
  })
})

describe('同一条通用工作流，换片段生成器即可换业务', () => {
  it('数字人口播：逐段发给厂商的是"形象图 + 音频 + 固定种子"，成片进草稿箱', async () => {
    vi.stubGlobal('fetch', vendorFetch())
    const human = await h.call<{ id: string }>('POST', 'digital-humans', { body: { name: '雅姐', avatarUrl: AVATAR_URL } })
    const task = await startTask({ producer: 'digital-human', producerRef: human.data.id, topic: '春季护肤套装', targetSeconds: 30 })

    expect(task.status, '流水线必须跑完：' + String(task.errorMessage)).toBe('success')
    expect(task.producer).toBe('digital-human')
    expect(task.totalSegments).toBeGreaterThanOrEqual(1)
    expect(task.doneSegments).toBe(task.totalSegments)
    expect(task.videoUrl, '成片必须落盘').toBeTruthy()
    for (const segment of task.segments)
      expect(segment.audioSeconds, '逐段真实时长必须回填').toBeGreaterThan(0)

    expect(captured.length).toBe(task.totalSegments)
    for (const payload of captured) {
      expect(payload.mode).toBe('reference')
      expect(payload.seed, '固定种子必须发给厂商').toBeTypeOf('number')
      expect(String((payload.images as string[])[0])).toContain('data:image/png;base64,')
      expect(String((payload.audios as string[])[0])).toContain('data:audio/mpeg;base64,')
      expect(Number(payload.seconds), '单段时长必须在厂商接受的 4~12 秒内').toBeGreaterThanOrEqual(4)
      expect(Number(payload.seconds)).toBeLessThanOrEqual(12)
    }

    // 字幕必须真的交到拼接：口播文本 + 各段真实时长组成的时间轴，缺一段都会飘。
    const cues = (composeCalls[0]?.subtitles ?? []) as Array<{ text: string, startSeconds: number, endSeconds: number }>
    expect(cues.length, '每个段落都要有一条字幕').toBe(task.totalSegments)
    expect(cues[0]!.startSeconds).toBe(0)
    for (let i = 1; i < cues.length; i++)
      expect(cues[i]!.startSeconds, '字幕时间轴必须首尾相接').toBeCloseTo(cues[i - 1]!.endSeconds, 5)
    expect(cues.map(cue => cue.text).join(''), '字幕文本必须覆盖全部口播稿').toContain('姐妹们注意了')

    const drafts = h.disk<Array<{ type: string, mediaList: Array<{ url: string }>, metadata?: Record<string, string> }>>('contents.json')
    const draft = drafts.find(item => item.metadata?.producer === 'digital-human')
    expect(draft, '成片必须登记成草稿').toBeTruthy()
    expect(draft?.type).toBe('video')
    expect(draft?.mediaList[0]?.url).toBe(task.videoUrl)
  }, 60_000)

  it('场景呈现：不出镜、不配音，插同一套编排照样出一条成片', async () => {
    vi.stubGlobal('fetch', vendorFetch())
    const task = await startTask({ producer: 'scene', topic: '秋冬保湿面霜的使用场景', targetSeconds: 24 })

    expect(task.status, '换生成器不改编排：' + String(task.errorMessage)).toBe('success')
    expect(task.producer).toBe('scene')
    expect(task.doneSegments).toBe(task.totalSegments)
    expect(task.videoUrl).toBeTruthy()

    // 场景片段是纯画面：不能带形象图/音频，走的是文生视频。
    for (const payload of captured) {
      expect(payload.mode).toBe('text')
      expect(payload.images, '场景呈现不得夹带形象图').toBeUndefined()
      expect(payload.audios, '场景呈现不得夹带配音').toBeUndefined()
    }
    // 每段画面按这句文案自己的体量要时长：固定 12 秒会让厂商把画面拖慢拉长成"慢动作空镜"。
    for (const segment of task.segments) {
      const payload = captured.find(item => item.prompt === segment.text)
      expect(payload, '每一段都要有对应的厂商请求').toBeTruthy()
      expect(Number(payload?.seconds), '场景段时长要按文案体量给').toBe(clampSegmentSeconds(estimateSeconds(segment.text)))
    }
    // 场景呈现的画面在写稿前就要按段数规划，模型才知道这条片有几个镜头可以铺。
    const writes = modelPrompts.filter(prompt => prompt.includes('你是短视频编剧'))
    expect(writes[0]).toContain('刚好 ' + String(planSegmentCount(24)) + ' 句')
    expect(writes[0], '相邻画面不许是同一个场景的重复描述').toContain('同一个场景的重复描述')

    const drafts = h.disk<Array<{ metadata?: Record<string, string> }>>('contents.json')
    expect(drafts.some(item => item.metadata?.producer === 'scene'), '场景成片同样要进草稿箱').toBe(true)
  }, 60_000)

  it('未知内容形式与已删除的形象都不建任务，如实报错', async () => {
    const unknown = await h.call('POST', 'long-videos', { body: { producer: 'no-such-kind', topic: '随便' } })
    expect(unknown.code, '未知生成器要当场拒绝').not.toBe(0)

    // 形象在开工前就被删掉：必须在建任务这一步就说清楚，而不是建一条注定跑不完的任务。
    const human = await h.call<{ id: string }>('POST', 'digital-humans', { body: { name: '临时', avatarUrl: AVATAR_URL } })
    await h.call('DELETE', 'digital-humans/' + human.data.id)
    const orphan = await h.call<{ taskId: string }>('POST', 'long-videos', {
      body: { producer: 'digital-human', producerRef: human.data.id, topic: '临时任务' },
    })
    expect(orphan.code, '形象不存在时必须当场拒绝').not.toBe(0)
    expect(String(orphan.message), '错误要说清是形象没了').toContain('形象')
  }, 60_000)

  it('没填卖点时不建任务', async () => {
    expect((await h.call('POST', 'long-videos', { body: { producer: 'scene', topic: '  ' } })).code).not.toBe(0)
    expect((await h.call('POST', 'long-videos', { body: { topic: '没有选内容形式' } })).code).not.toBe(0)
  })
})

describe('分镜表驱动执行：口播镜与产品镜各走各的路', () => {
  it('模型排出的分镜被真的执行：产品镜不带音视频、口播镜走 reference 模式', async () => {
    vi.stubGlobal('fetch', vendorFetch())
    const human = await h.call<{ id: string }>('POST', 'digital-humans', { body: { name: '雅姐', avatarUrl: AVATAR_URL } })
    // 夹具：2 个口播镜夹 1 个产品镜——这正是"人只出镜一半时间"的最小形态。
    modelShotPlan = JSON.stringify({
      continuity: '米色墙背景，室内柔和暖光，竖屏构图',
      shots: [
        { kind: 'talking-head', seconds: 6, line: '姐妹们，秋冬脸干到起皮，化妆卡粉特别明显。', beat: 'hook' },
        { kind: 'product', seconds: 5, visual: '以参考图中的产品为主体缓慢旋转，微距特写，画面里不出现任何文字与品牌标识', beat: 'product' },
        { kind: 'talking-head', seconds: 6, line: '这款面霜涂完不黏不闷，第二天上妆也不卡。', beat: 'cta' },
      ],
    })
    const task = await startTask({ producer: 'digital-human', producerRef: human.data.id, topic: '干皮救急面霜', targetSeconds: 17 })

    expect(task.status, '流水线必须跑完：' + String(task.errorMessage)).toBe('success')
    expect(task.totalSegments, '按分镜跑，不是按稿件切段').toBe(3)
    expect(task.doneSegments).toBe(3)

    const shots = task.shots ?? []
    expect(shots.map(item => item.kind)).toEqual(['talking-head', 'product', 'talking-head'])
    expect(shots.every(item => item.status === 'ready'), '每一镜都要有终态').toBe(true)
    // 分镜表落盘：逐镜重做要靠它定位，界面也要拿它显示镜头类型。
    expect(task.segments[0]!.text, '口播镜的文本就是它的台词').toContain('秋冬脸干到起皮')
    expect(task.segments[1]!.text, '产品镜没有台词').toBe('')
    expect(task.segments[1]!.audioSeconds, '产品镜时长以厂商成片为准，同样要回填').toBeGreaterThan(0)

    // 厂商侧：3 次调用，其中产品镜必须是纯文生视频，绝不能夹带形象图/配音。
    expect(captured).toHaveLength(3)
    expect(captured[1]!.mode, '产品镜走图生视频/文生视频，不是 reference 口播').toBe('text')
    expect(captured[1]!.images, '产品镜不得夹带人物形象图（画面主体是产品）').toBeUndefined()
    expect(captured[1]!.audios, '产品镜不得夹带配音').toBeUndefined()
    expect(String(captured[1]!.prompt), '产品镜用画面提示词，且带上连续性约束').toContain('米色墙背景')
    expect(String(captured[1]!.prompt)).toContain('微距特写')
    for (const index of [0, 2]) {
      expect(captured[index]!.mode, '口播镜走 reference 模式').toBe('reference')
      expect(String(captured[index]!.audios?.[0] ?? '')).toContain('data:audio/mpeg;base64,')
    }
    // 配音只发生在口播镜：产品镜不该白花一次 TTS。
    expect(ttsCalls, '两段口播 = 两次配音').toHaveLength(2)
  }, 60_000)

  it('给了产品图：产品镜以真实产品为主体；不给：产品镜不带任何图片', async () => {
    vi.stubGlobal('fetch', vendorFetch())
    const human = await h.call<{ id: string }>('POST', 'digital-humans', { body: { name: '雅姐', avatarUrl: AVATAR_URL } })
    modelShotPlan = JSON.stringify({
      shots: [
        { kind: 'talking-head', seconds: 6, line: '姐妹们，秋冬脸干到起皮。' },
        { kind: 'product', seconds: 5, visual: '产品缓慢旋转，微距特写，画面里不出现任何文字与品牌标识' },
      ],
    })

    // ① 不给产品图：产品镜不得带任何图片字段（凭空画一个产品比"只有口播"更糟）。
    captured = []
    await startTask({ producer: 'digital-human', producerRef: human.data.id, topic: '干皮救急面霜', targetSeconds: 11 })
    expect(captured, '两镜两次调用').toHaveLength(2)
    expect(captured[1]!.mode, '没有产品图 → 纯文生视频').toBe('text')
    expect(captured[1]!.first_frame, '不得凭空塞参考图').toBeUndefined()

    // ② 给了产品图：产品镜以它为首帧（厂商的 1 张图 = keyframe 模式，字段名是 first_frame）。
    captured = []
    await startTask({
      producer: 'digital-human',
      producerRef: human.data.id,
      topic: '干皮救急面霜',
      targetSeconds: 11,
      productImageUrl: PRODUCT_URL,
    })
    expect(captured[1]!.mode, '1 张产品图 → 首帧模式').toBe('keyframe')
    expect(String(captured[1]!.first_frame), '带的必须是用户那张产品图的字节').toContain('data:image/png;base64,')
    expect(captured[0]!.mode, '口播镜不受影响，仍走 reference').toBe('reference')
  }, 60_000)

  it('产品图读不出来时当场拒绝建任务，不建一条注定跑不完的任务', async () => {
    const orphan = await h.call('POST', 'long-videos', {
      body: { producer: 'scene', topic: '随便', productImageUrl: '/bosom-friend/api/assets/file/nope.png' },
    })
    expect(orphan.code).not.toBe(0)
    expect(String(orphan.message)).toContain('产品图')
  })

  it('分镜要求里必须带上"产品镜下限"与"画字禁令"', async () => {
    vi.stubGlobal('fetch', vendorFetch())
    const human = await h.call<{ id: string }>('POST', 'digital-humans', { body: { name: '雅姐', avatarUrl: AVATAR_URL } })
    modelScripts = [LONG_SCRIPT]
    modelShotPlan = JSON.stringify({ shots: [{ kind: 'talking-head', seconds: 6, line: '一句话就够。' }] })
    await startTask({ producer: 'digital-human', producerRef: human.data.id, topic: '任何产品', targetSeconds: 12 })
    const directorPrompt = modelPrompts.find(prompt => prompt.includes('只输出 JSON')) ?? ''
    expect(directorPrompt, '分镜那次调用要认出自己是导演').toContain('你是短视频导演')
    expect(directorPrompt).toContain('至少 ' + String(MIN_PRODUCT_SHOTS) + ' 个 product 镜头')
    expect(directorPrompt).toContain('不许出现任何文字、品牌名、logo')
  }, 60_000)
})

describe('产品与卖点：专业提示词增强', () => {
  it('空输入不调用模型，超长输入如实拒绝', async () => {
    expect((await h.call('POST', 'long-videos/enhance-topic', { body: { topic: '   ' } })).code).not.toBe(0)
    expect(modelPrompts, '空输入不该白跑一次模型').toHaveLength(0)
    const tooLong = await h.call('POST', 'long-videos/enhance-topic', { body: { topic: '面霜'.repeat(300) } })
    expect(tooLong.code, '超长输入要如实拒绝而不是截断').not.toBe(0)
    expect(modelPrompts).toHaveLength(0)
  })

  it('增强结果取模型原文，且要求里带上用户原话与"不许编造"', async () => {
    const enhanced = '目标人群：25-35 岁干皮女生。使用场景：秋冬上妆前。痛点是卡粉起皮。'
    modelScripts = [enhanced]
    const res = await h.call<{ topic: string }>('POST', 'long-videos/enhance-topic', {
      body: { topic: '秋冬保湿面霜，主打干皮救急，今天直播间直降一百' },
    })
    expect(res.code).toBe(0)
    expect(res.data.topic).toBe(enhanced)
    expect(modelPrompts).toHaveLength(1)
    expect(modelPrompts[0], '原话必须带进提示词').toContain('秋冬保湿面霜，主打干皮救急，今天直播间直降一百')
    expect(modelPrompts[0], '必须禁止编造成分与功效').toContain('不要写')
    expect(modelPrompts[0], '增强只出文本，不该顺带建任务').toContain('不要标题')
  })
})

describe('音色试听：按需合成、缓存复用', () => {
  it('合成后以音频返回，样音落盘且同一音色第二次复用', async () => {
    const voiceId = 'zh-CN-XiaoyiNeural'
    const path = 'digital-humans/voices/' + voiceId + '/preview'
    const cache = join(h.dataRoot, 'voice-previews')
    expect(existsSync(cache), '试听前不该有缓存目录').toBe(false)

    const first = await h.call('GET', path, { query: { text: '这款面霜干皮救急' } })
    expect(first.status).toBe(200)
    expect(first.headers['content-type'], '响应的必须是音频，不是 JSON 信封').toBe('audio/mpeg')
    // 试听只要字节：不该为了一个播放器用不到的数字要求本机有 ffmpeg。
    expect(ttsCalls[0]?.probeDuration, '试听不得读取时长').toBe(false)
    const cached = readdirSync(cache)
    expect(cached, '样音要落在数据根里，下次直接命中').toHaveLength(1)
    expect(readFileSync(join(cache, cached[0]!)).length).toBeGreaterThan(0)

    // 同一音色第二次：命中同一份缓存文件，不新增文件。
    expect((await h.call('GET', path, { query: { text: '这款面霜干皮救急' } })).status).toBe(200)
    expect(readdirSync(cache)).toEqual(cached)

    // 缺省样音（不带 text）与自定义文案是两份不同的样音：不拿上一句冒充这一句。
    expect((await h.call('GET', path)).status).toBe(200)
    expect(readdirSync(cache)).toHaveLength(2)
  })

  it('未知音色当场拒绝，不去连配音服务', async () => {
    const res = await h.call('GET', 'digital-humans/voices/zh-CN-NoSuchVoice/preview')
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('音色')
  })

  it('接口给出的音色全部可试听（列表与试听路由同一份事实源）', async () => {
    const voices = await h.call<{ list: Array<{ id: string }> }>('GET', 'digital-humans/voices')
    for (const voice of voices.data.list) {
      const res = await h.call('GET', 'digital-humans/voices/' + encodeURIComponent(voice.id) + '/preview')
      expect(res.status, voice.id + ' 必须能试听').toBe(200)
    }
  })
})
