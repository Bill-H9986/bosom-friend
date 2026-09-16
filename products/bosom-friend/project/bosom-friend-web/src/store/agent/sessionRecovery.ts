/**
 * 后端在会话恢复失败时会创建一个新的任务 id。
 * 前端需要感知这个变化并同步路由，否则会停留在旧任务上，
 * 旧任务卡与新任务卡同时出现，形成“一个会话多个窗口”的假象。
 */
export function isRecoveredTaskId(currentTaskId: string, nextTaskId?: string): boolean {
  return Boolean(nextTaskId && nextTaskId !== currentTaskId)
}
