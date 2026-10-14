/**
 * DEF-240-IMPLEMENT-3：自动发布授权闸门的隔离执行器测试。
 *
 * 三条纪律：
 *   1. 只用**真实**判定函数与真实闸门，不复制规则（判据从服务端编译产物 import，闸门从前端源码 import）；
 *   2. 发布执行器一律是**替身**，只累加计数 —— 不接触抖音、插件平台或任何真实接口；
 *   3. 断言的是**执行器实际调用次数**，不是某个布尔值。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isAutoPublishAuthorized } from '@web/components/Chat/ActionCard/publishAuthorization'
import { useAgentFollowStore } from '@web/store/agentFollow'

type Detect = (prompt: string) => boolean
type CurTurn = (prompt: unknown) => string
let detectPublishIntent: Detect
let extractCurrentTurnText: CurTurn

beforeAll(async () => {
  const api = await import('../../server/lib/types/api.js')
  detectPublishIntent = api.detectPublishIntent as Detect
  extractCurrentTurnText = api.extractCurrentTurnText as CurTurn
  expect(typeof detectPublishIntent).toBe('function')
  expect(typeof extractCurrentTurnText).toBe('function')
})

/** 模拟发布执行器：唯一的副作用是计数。 */
let executorCalls = 0
const fakePublishExecutor = () => { executorCalls += 1 }

/** 复刻服务端产出动作卡的那一步：只有判据为真才写授权标记。 */
function buildActionCard(prompt: unknown) {
  const turnText = extractCurrentTurnText(prompt)
  const wantsPublish = detectPublishIntent(turnText)
  return wantsPublish
    ? { type: 'fullContent', action: 'navigateToPublish', explicitPublishIntent: true as const }
    : { type: 'fullContent', action: 'navigateToPublish' }
}

/** 自动执行判定：闸门放行才真的调执行器。 */
function tryAutoPublish(action: { explicitPublishIntent?: boolean }) {
  if (!isAutoPublishAuthorized(action)) return false
  fakePublishExecutor()
  return true
}

function setFollow(enabled: boolean) {
  useAgentFollowStore.getState().setEnabled(enabled)
}

beforeEach(() => {
  executorCalls = 0
  setFollow(false)
})

describe('B. 未授权情形 —— 执行器调用次数必须为 0', () => {
  it('缺授权标记', () => {
    setFollow(true)
    expect(tryAutoPublish({})).toBe(false)
    expect(executorCalls).toBe(0)
  })

  it('标记为 false', () => {
    setFollow(true)
    expect(tryAutoPublish({ explicitPublishIntent: false })).toBe(false)
    expect(executorCalls).toBe(0)
  })

  it('跟随模式关闭（即使标记为 true）', () => {
    setFollow(false)
    expect(tryAutoPublish({ explicitPublishIntent: true })).toBe(false)
    expect(executorCalls).toBe(0)
  })

  it('跟随模式关闭且无标记', () => {
    setFollow(false)
    expect(tryAutoPublish({})).toBe(false)
    expect(executorCalls).toBe(0)
  })

  it('标记类型不匹配（字符串 true 不得放行）', () => {
    setFollow(true)
    expect(isAutoPublishAuthorized({ explicitPublishIntent: 'true' as unknown as boolean })).toBe(false)
    expect(executorCalls).toBe(0)
  })

  it('标记为 null / undefined / 0 / 空串 / 对象 均不得放行', () => {
    setFollow(true)
    for (const bad of [null, undefined, 0, '', {}]) {
      expect(isAutoPublishAuthorized({ explicitPublishIntent: bad as unknown as boolean })).toBe(false)
    }
    expect(executorCalls).toBe(0)
  })
})

describe('C. 普通提问 / 否定 / 引述 / 模糊意图 —— 不得触发自动执行', () => {
  const NON_AUTHORIZING = [
    ['普通提问', '你能帮我发布吗？'],
    ['否定句', '我不打算发布，只是问问。'],
    ['引述指令', '老板让我发布到抖音 我不知道怎么弄'],
    ['假设场景', '假如我说发布到小红书，你会怎么做？'],
    ['要求分析', '帮我分析这句话是不是发布指令：发布到抖音。'],
    ['打听流程', '发布流程是怎样的？'],
    ['模糊意图', '就这个吧。'],
    ['模糊意图', '好的，按你说的做。'],
    ['拒发式', '这条先不要发，我再改改。'],
  ] as const

  it.each(NON_AUTHORIZING)('%s：%s', (_label, prompt) => {
    setFollow(true)
    const action = buildActionCard(prompt)
    expect(action.explicitPublishIntent).toBeUndefined()
    expect(tryAutoPublish(action)).toBe(false)
    expect(executorCalls).toBe(0)
  })
})

describe('D. 历史文本混入 —— 不得由旧对话产生授权', () => {
  it('数组里历史含发布指令、当前轮无意图', () => {
    setFollow(true)
    const arr = [
      { type: 'text', text: '把这条内容发布到抖音。' },
      { type: 'text', text: '今天天气不错' },
    ]
    const action = buildActionCard(arr)
    expect(extractCurrentTurnText(arr)).toBe('今天天气不错')
    expect(action.explicitPublishIntent).toBeUndefined()
    expect(tryAutoPublish(action)).toBe(false)
    expect(executorCalls).toBe(0)
  })
})

describe('E. 明确发布指令 + 授权条件满足 —— 进入模拟执行路径', () => {
  const AUTHORIZING = [
    ['祈使式', '把这条内容发布到抖音。'],
    ['祈使式', '写好之后发出去。'],
    ['祈使式', '上传到B站。'],
    // 「不要发成别的内容」是质量约束（只发这一条），不是拒发——2026-10-13 真机考试现场
    // 被误判成否定，页脚错误地显示"尚未发布"。
    ['约束式', '把草稿直接发布到小红书，不要发成别的内容，完成后把作品 ID 告诉我。'],
  ] as const

  it.each(AUTHORIZING)('%s：%s', (_label, prompt) => {
    setFollow(true)
    const action = buildActionCard(prompt)
    expect(action.explicitPublishIntent).toBe(true)
    expect(tryAutoPublish(action)).toBe(true)
    expect(executorCalls).toBe(1)
  })
})

describe('F. 人工确认路径仍然可用', () => {
  it('未授权时不自动执行，但仍可走人工确认', () => {
    setFollow(true)
    const action = buildActionCard('你能帮我发布吗？')
    expect(tryAutoPublish(action)).toBe(false)
    expect(executorCalls).toBe(0)
    fakePublishExecutor()
    expect(executorCalls).toBe(1)
  })

  it('跟随模式关闭时，明确指令也不自动执行，但人工确认仍可发布', () => {
    setFollow(false)
    const action = buildActionCard('把这条内容发布到抖音。')
    expect(action.explicitPublishIntent).toBe(true)
    expect(tryAutoPublish(action)).toBe(false)
    expect(executorCalls).toBe(0)
    fakePublishExecutor()
    expect(executorCalls).toBe(1)
  })
})

describe('G. 授权不跨任务继承', () => {
  it('上一轮明确授权，不使下一轮的提问获得自动发布', () => {
    setFollow(true)
    const first = buildActionCard('把这条内容发布到抖音。')
    expect(tryAutoPublish(first)).toBe(true)
    expect(executorCalls).toBe(1)

    executorCalls = 0
    const second = buildActionCard('你能帮我发布吗？')
    expect(second.explicitPublishIntent).toBeUndefined()
    expect(tryAutoPublish(second)).toBe(false)
    expect(executorCalls).toBe(0)
  })
})
