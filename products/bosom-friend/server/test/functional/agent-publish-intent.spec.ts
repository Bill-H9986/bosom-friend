import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { detectPublishIntent } from '../../src/api.ts'
import { createHarness } from '../harness.ts'
import type { Harness, SseFrame } from '../harness.ts'

/**
 * 发布闸门：用户没有明确要求发布时，智能体不得产出「去发布」动作卡。
 *
 * 跟随模式下前端会自动执行 `navigateToPublish` 动作卡（选账号 → 提交 → 跳数据中心同步），
 * 所以"有没有这张卡"就等于"会不会替用户发出去"。这里用内核桩把模型回复固定住，
 * 只让服务端自己的意图判定起作用，跑的是真实路由（POST agent/tasks 的 SSE 通道）。
 */
vi.mock('../../src/kernel-client.ts', () => ({
  createKernelClient: () => ({
    prompt: async (prompt: string, onDelta?: (text: string) => void) => {
      const text = '小红书笔记文案\n标题：春季护肤三步走\n正文：先清洁，再保湿，最后防晒。\n#护肤 #春季'
      onDelta?.(text)
      return { text }
    },
    close: async () => {},
  }),
}))

// 封面引擎不在本用例的验证范围（它要拉起真实浏览器引擎）；桩掉它，只留服务端的动作卡判定。
vi.mock('../../src/platform-login.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/platform-login.ts')>()
  return { ...actual, generateNoteCover: async () => ({ ok: false as const, error: '测试桩：封面引擎不参与' }) }
})

let h: Harness

beforeAll(() => {
  h = createHarness()
  // 配一个大模型，否则服务端走"未配置"分支，压根到不了动作卡判定。
  return h.call('PUT', 'ai/user-llm', {
    body: {
      providers: [{
        id: 'chat',
        displayName: '对话网关',
        baseUrl: 'https://chat.example.com/v1',
        apiKey: 'sk-chat-probe',
        models: ['chat-probe'],
      }],
      activeProviderId: 'chat',
    },
  })
})
afterAll(() => {
  h.dispose()
})

/** 从 SSE 帧里取出助理消息携带的动作卡（result 载荷）。 */
function actionCards(frames: SseFrame[]): Array<Record<string, unknown>> {
  const cards: Array<Record<string, unknown>> = []
  for (const frame of frames) {
    if (frame.type !== 'result') continue
    const data = frame.data as { result?: unknown } | undefined
    if (!Array.isArray(data?.result)) continue
    cards.push(...data.result as Array<Record<string, unknown>>)
  }
  return cards
}

/** 从 SSE 帧里取出最终正文。 */
function replyText(frames: SseFrame[]): string {
  const result = [...frames].reverse().find(frame => frame.type === 'result')
  const data = result?.data as { content?: unknown } | undefined
  return typeof data?.content === 'string' ? data.content : ''
}

describe('发布闸门：没说要发布就不给发布入口', () => {
  it('「写一篇笔记」只交付内容，不产出发布动作卡', async () => {
    const res = await h.call('POST', 'agent/tasks', {
      body: { prompt: '帮我写一篇小红书春季护肤种草笔记，先把完整文案写出来。', includePartialMessages: true },
    })
    const cards = actionCards(res.sse)
    expect(cards.map(card => card.action), '没有发布指令就不得出现任何发布动作卡')
      .not.toContain('navigateToPublish')
    expect(replyText(res.sse), '正文必须如实说明还没发布').toContain('尚未发布')
  })

  it('「打开发布日历」这类问询同样不算发布指令', async () => {
    const res = await h.call('POST', 'agent/tasks', {
      body: { prompt: '帮我看看发布记录里昨天那条笔记的数据表现。', includePartialMessages: true },
    })
    expect(actionCards(res.sse).map(card => card.action)).not.toContain('navigateToPublish')
  })

  it('明确说「发布」时才产出「去发布」动作卡', async () => {
    const res = await h.call('POST', 'agent/tasks', {
      body: { prompt: '帮我在小红书发布一篇春季护肤种草笔记，先把完整文案写出来。', includePartialMessages: true },
    })
    const published = actionCards(res.sse).find(card => card.action === 'navigateToPublish')
    expect(published, '用户明确要求发布时必须给出发布入口').toBeTruthy()
    expect(published?.type).toBe('fullContent')
  })
})

describe('发布意图判定：只认用户亲口说出的发布措辞', () => {
  it('创作类说法一律不算发布', () => {
    for (const prompt of [
      '帮我写一篇小红书春季护肤种草笔记',
      '生成一条抖音口播短视频文案，30 秒内',
      '帮我创作一条关于重庆山城夜景的脚本',
      '做个产品介绍视频，主题是无人机培训',
      '先给我一版标题和正文',
    ])
      expect(detectPublishIntent(prompt), prompt).toBe(false)
  })

  it('明确的发布说法算发布', () => {
    for (const prompt of [
      '把刚才那篇笔记发布到小红书',
      '帮我发一条抖音视频',
      '这条内容发出去',
      '发布',
      '同步到小红书',
      '帮我上传到抖音',
    ])
      expect(detectPublishIntent(prompt), prompt).toBe(true)
  })

  it('打听发布相关的事不算发布指令', () => {
    for (const prompt of [
      '帮我看看发布记录',
      '发布日历里下周有安排吗',
      '抖音的发布频率一般多少合适',
      '上次发布失败是什么原因',
      '打开发布设置',
    ])
      expect(detectPublishIntent(prompt), prompt).toBe(false)
  })

  it('明确说了先别发时不算发布指令', () => {
    for (const prompt of [
      '先写文案给我看，先不要发布',
      '帮我做一条抖音视频，先别发出去',
      '内容先存着，暂不发布',
    ])
      expect(detectPublishIntent(prompt), prompt).toBe(false)
  })
})
