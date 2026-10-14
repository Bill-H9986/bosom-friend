/**
 * 已声明例外：**有意的不一致**。
 *
 * 纪律（本表本身也防漂移）：
 * - 每条必须给 category 与可复核的 reason
 * - 只允许两类 category：
 *     cross-world : 两个世界本来就不同（产品 ID vs 引擎 ID），不可能消除
 *     planned     : 后端已登记为「计划中」（如 coming_soon），属于有意的时间差
 * - **禁止「为了让检测通过」的例外** —— 这类必须报 DRIFT。
 */
export const ALLOWED_CATEGORIES = ['cross-world', 'planned']
export const EXCEPTIONS = {
  'publish-platforms': [
    { value: 'youtube', category: 'cross-world', reason: '引擎保留 youtube 模块；产品只做国内平台（platform-catalog.ts:100-101）' },
  ],
  'platform-keys': [
    { value: 'xianyu', category: 'planned', reason: '后端 PLANNED_PLATFORMS 已登记为 coming_soon（platform-catalog.ts:110-112）' },
  ],
}
export function exceptionValues(ruleId) {
  const list = EXCEPTIONS[ruleId] ?? []
  for (const e of list) {
    if (!ALLOWED_CATEGORIES.includes(e.category))
      throw new Error('非法的例外 category: ' + e.category + '（只允许 ' + ALLOWED_CATEGORIES.join('/') + '）')
  }
  return list.map(e => e.value)
}
