import { useAgentFollowStore } from '@web/store/agentFollow'
/**
 * 自动发布授权闸门 —— **所有自动发布路径的唯一入口**。
 *
 * 发布于外、不可撤销，因此自动执行（无需用户点击）必须同时满足两条：
 *   ① 用户开启了跟随模式；② 这张动作卡带**本轮明确发布意图**标记。
 *
 * 标记由服务端 `detectPublishIntent(extractCurrentTurnText(prompt))` 判定后写入，
 * 前端只消费、不推断：**模型回复、动作卡内容、工具调用成功都不构成授权**。
 * 缺失 / 非 true / 历史动作卡一律视为未授权（fail-closed），落到人工确认路径。
 *
 * 2026-10-09 事故（DEF-240）：跟随模式默认开启，且 `PluginPublishCard` 的实时倒计时
 * 只看 `_isRealtime`，普通提问被判为发布指令后自动执行，触发了一次真实发布尝试。
 * 两条路径现在共用本函数，避免各自维护一份判断而漂移。
 *
 * **本函数不是安全证明**：它依赖的标记来自启发式判据，可能漏判；
 * 未授权发布未被杜绝，只是被收窄到「判据判错」这一条路径上。
 *
 * @param action - 待执行的发布动作卡。
 * @returns true 表示允许**自动**执行；false 表示只能走用户手动确认。
 */
export function isAutoPublishAuthorized(action: { explicitPublishIntent?: boolean }): boolean {
  if (action.explicitPublishIntent !== true) return false
  return useAgentFollowStore.getState().enabled === true
}