import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness, SseFrame } from '../harness.ts'

/**
 * 对话导航意图：用户说「打开知识库」这类话时，服务端必须产出对应的导航动作卡。
 *
 * 为什么单独锁这一条：AC-018-1 的端到端用例要真实调模型，模型慢或答非所问时断言会判红
 * （2026-09-13 与 2026-09-18 各实测到一次「服务端其实已产出 navigateToKnowledge，断言在
 * 180 秒到点判红」）。导航判定本来就不依赖模型（NAVIGATE_VERB + 页面名模式，见 src/api.ts），
 * 所以用内核桩把模型固定住，在这里逐页钉死「哪句话产出哪张卡」——模型侧的偶发不再能掩盖
 * 服务端的确定性。
 */
vi.mock('../../src/kernel-client.ts', async () => ({
  // 上下文两个助手用**真实实现**：mock 掉内核不等于可以把它们也换成空实现，
  // 否则"对话稿有没有真的带上历史"就没人测了。工厂里不能用顶层变量（会被提升），所以用 importActual。
  ...(({ chatTranscript, chatSessionId }) => ({ chatTranscript, chatSessionId }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  ),
  createKernelClient: () => ({
    prompt: async (_prompt: string, onDelta?: (text: string) => void) => {
      const text = '好的，我这就带你过去。'
      onDelta?.(text)
      return { text }
    },
    close: async () => {},
  }),
}))

let h: Harness

beforeAll(() => {
  h = createHarness()
  // 不配大模型时服务端走「未配置」分支，但导航卡与模型无关；仍配上，让用例走真实的主流式路径。
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

/** 从 SSE 帧里取出 result 载荷携带的动作卡。 */
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

// 七个功能页各一句自然说法：类型必须与前端 NAVIGATE_ROUTES 的键逐字一致。
const CASES: Array<{ prompt: string, action: string, label: string }> = [
  { prompt: '打开知识库。', action: 'navigateToKnowledge', label: '知识库' },
  { prompt: '帮我打开草稿箱。', action: 'navigateToDraft', label: '草稿箱' },
  { prompt: '带我去全局监控看看。', action: 'navigateToMonitor', label: '全局监控' },
  { prompt: '帮我打开数据中心，我想看播放量。', action: 'navigateToDatacenter', label: '数据中心' },
  { prompt: '带我去发布日历。', action: 'navigateToCalendar', label: '发布日历' },
  { prompt: '打开我的任务。', action: 'navigateToTasks', label: '任务历史' },
  { prompt: '带我去 AI 互动接待。', action: 'navigateToReception', label: 'AI 互动接待' },
]

describe('对话导航意图：七个功能页都能只靠一句话拿到入口', () => {
  for (const item of CASES) {
    it('「' + item.prompt + '」产出 ' + item.action, async () => {
      const res = await h.call('POST', 'agent/tasks', {
        body: { prompt: item.prompt, includePartialMessages: true },
      })
      const card = actionCards(res.sse).find(entry => entry.action === item.action)
      expect(card, '这句话必须产出 ' + item.action + ' 动作卡').toBeTruthy()
      expect(card?.type, '导航卡的类型是 navigate').toBe('navigate')
      expect(card?.title, '导航卡要写明去哪一页').toBe(item.label)
    })
  }

  it('创作需求不产出任何导航卡（不能把用户从创作页带走）', async () => {
    const res = await h.call('POST', 'agent/tasks', {
      body: { prompt: '帮我写一篇小红书的春季护肤种草笔记。', includePartialMessages: true },
    })
    const actions = actionCards(res.sse).map(card => card.action)
    expect(actions.filter(action => String(action).startsWith('navigateTo')), '创作需求不得带导航卡').toEqual([])
  })
})
