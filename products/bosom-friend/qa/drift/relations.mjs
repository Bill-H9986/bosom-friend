/**
 * 关系判定器。每种关系一个纯函数，输出四类结果码之一。
 * 提取失败（空集）绝不能判成 CONSISTENT —— 那是本仓库第一阶段踩过的假阴性。
 */
export const R = {
  CONSISTENT: 'CONSISTENT', DRIFT: 'DRIFT', SINGLE_SOURCE: 'SINGLE_SOURCE',
  DECLARED_EXCEPTION: 'DECLARED_EXCEPTION', DEAD_CODE: 'DEAD_CODE', EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  // 规则**不适用**：前提条件合法地不存在（例如表中确实没有任何已声明的话题上限）。
  // 它**不是**通过——本规则未做数值比较；也**不是**提取失败——表结构可正常解析。
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  // 证据不足以支撑结论（如存在无法排除的动态访问）—— 必须与 DEAD_CODE 严格区分
  UNVERIFIED: 'UNVERIFIED',
}
const guard = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return R.EXTRACTION_FAILED
  if (a.length === 0 || b.length === 0) return R.EXTRACTION_FAILED
  return null
}
export function setEquality(a, b, { exceptions = [] } = {}) {
  const bad = guard(a, b); if (bad) return { status: bad, detail: ['某一侧为空集'] }
  const onlyA = a.filter(x => !b.includes(x) && !exceptions.includes(x))
  const onlyB = b.filter(x => !a.includes(x) && !exceptions.includes(x))
  const detail = []
  if (onlyA.length) detail.push('仅在A: ' + onlyA.join(','))
  if (onlyB.length) detail.push('仅在B: ' + onlyB.join(','))
  return { status: detail.length ? R.DRIFT : R.CONSISTENT, detail }
}
export function subset(a, b, { exceptions = [] } = {}) {
  const bad = guard(a, b); if (bad) return { status: bad, detail: ['某一侧为空集'] }
  const missing = a.filter(x => !b.includes(x) && !exceptions.includes(x))
  return { status: missing.length ? R.DRIFT : R.CONSISTENT, detail: missing.length ? ['A 中有 B 没有: ' + missing.join(',')] : [] }
}
export function predicateUniqueness(locations, { expected = 1, primaryFound = true } = {}) {
  if (!Array.isArray(locations)) return { status: R.EXTRACTION_FAILED, detail: ['locations 不是数组'] }
  if (!primaryFound) return { status: R.EXTRACTION_FAILED, detail: ['主判据未找到'] }
  if (locations.length === 0) return { status: R.SINGLE_SOURCE, detail: ['判据只有一处，无散落副本'] }
  return locations.length > expected
    ? { status: R.DRIFT, detail: ['判据出现 ' + locations.length + ' 处（应 ' + expected + '）: ' + locations.join(' | ')] }
    : { status: R.CONSISTENT, detail: [] }
}
export function deadCode(definition, referenceCount) {
  if (!definition) return { status: R.EXTRACTION_FAILED, detail: ['定义未找到'] }
  return referenceCount === 0
    ? { status: R.DEAD_CODE, detail: ['定义存在但 0 处引用（不是漂移，是从未被使用的第一份事实）'] }
    : { status: R.CONSISTENT, detail: [] }
}