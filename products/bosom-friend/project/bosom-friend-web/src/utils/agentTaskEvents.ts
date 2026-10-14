/**
 * 「我的任务」列表变更广播。
 *
 * 为什么需要它：任务列表页只在挂载时拉一次，之后靠 30 秒轮询与窗口聚焦兜底。
 * AI 侧边栏就在同一个页面上，用户点「新对话」、发出第一句话、任务收尾——这些时刻
 * 列表都该立刻变，而不是等他手动点刷新（实测用户就是这么反馈的："每次新开对话都要手动刷新"）。
 *
 * 用浏览器事件而不是把列表状态塞进全局 store：AI 侧边栏与任务页是两个互不依赖的模块，
 * 事件是它们之间最窄的耦合面（与 useDraftGenerationPricing 的缓存失效广播同一口径）。
 */

/** 事件名（带产品前缀，避免与别处的同名事件撞车）。 */
const TASKS_CHANGED_EVENT = 'bf:agent-tasks-changed'

/** 通知所有正在看任务列表的地方：任务集合变了。 */
export function notifyAgentTasksChanged(): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(TASKS_CHANGED_EVENT))
}

/**
 * 订阅任务集合变化。
 *
 * @param listener - 变化时要执行的动作（调用方自己决定怎么重拉）。
 * @returns 取消订阅的函数。
 */
export function subscribeAgentTasksChanged(listener: () => void): () => void {
  if (typeof window === 'undefined')
    return () => {}
  window.addEventListener(TASKS_CHANGED_EVENT, listener)
  return () => window.removeEventListener(TASKS_CHANGED_EVENT, listener)
}
