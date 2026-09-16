/**
 * 账号数据链探针：账号库 ↔ 发布记录 ↔ 互动指标 ↔ 数据中心接口 的一致性核对。
 * 只读：不改任何数据、不触发同步。
 * 用法：node products/bosom-friend/qa/probes/probe-account-data.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const root = join(homedir(), '.bosom-friend', 'bosom-friend')

/** 落库文件是信封 {schemaVersion, value:[...]}；按数组解析会静默得到 0 条。 */
function loadEnvelope(name) {
  const parsed = JSON.parse(readFileSync(join(root, name), 'utf8'))
  if (Array.isArray(parsed)) return { items: parsed, format: 'raw-array' }
  return { items: Array.isArray(parsed.value) ? parsed.value : [], format: 'envelope' }
}

const api = async path => {
  const response = await fetch(BASE + path)
  const envelope = await response.json().catch(() => null)
  return { http: response.status, code: envelope?.code, data: envelope?.data, message: envelope?.message }
}

const accountsFile = loadEnvelope('accounts.json')
const recordsFile = loadEnvelope('publish-records.json')
const metricsFile = loadEnvelope('metrics.json')
const accounts = accountsFile.items
const records = recordsFile.items
const metrics = metricsFile.items

const accountApi = await api('api/v2/channels/accounts')
const apiAccounts = accountApi.data?.list ?? []
const dashboard = await api('api/v2/statistics/published-content-summary/dashboard')

const out = { root, accountFileFormat: accountsFile.format, counts: {
  accountsOnDisk: accounts.length,
  accountsFromApi: apiAccounts.length,
  records: records.length,
  metrics: metrics.length,
  dashboardHttp: dashboard.http,
  dashboardCode: dashboard.code,
} }

out.accounts = accounts.map(a => ({
  id: a.id,
  type: a.type,
  nickname: a.nickname,
  nicknameIsPlaceholder: ['抖音', '小红书', 'No name'].includes(String(a.nickname)),
  fansCount: a.fansCount,
  workCount: a.workCount,
  loginState: a.loginState ?? null,
  hasCookie: typeof a.loginCookie === 'string' && a.loginCookie !== '',
  recordsForAccount: records.filter(r => r.accountId === a.id).length,
  metricsForAccount: metrics.filter(m => m.accountId === a.id).length,
  publishedForAccount: records.filter(r => r.accountId === a.id && r.status === 1).length,
}))

const accountIds = new Set(accounts.map(a => a.id))
out.orphanRecords = records.filter(r => !accountIds.has(r.accountId)).map(r => ({ id: r.id, accountId: r.accountId, status: r.status }))
out.orphanMetrics = metrics.filter(m => !accountIds.has(m.accountId)).map(m => ({ workId: m.workId, accountId: m.accountId }))

const recordWorkIds = records.map(r => String(r.platformWorkId ?? '')).filter(v => v !== '')
const duplicateWorkIds = recordWorkIds.filter((v, i) => recordWorkIds.indexOf(v) !== i)
out.duplicatePlatformWorkIds = [...new Set(duplicateWorkIds)]

out.recordsMissingEvidence = records
  .filter(r => r.status === 1)
  .filter(r => !r.platformWorkId || !r.workLink || !r.publishTime)
  .map(r => ({ id: r.id, status: r.status, platformWorkId: r.platformWorkId ?? '', workLink: r.workLink ?? '', publishTime: r.publishTime ?? '' }))

out.recordsByStatus = records.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {})
out.recordsByType = records.reduce((acc, r) => { const k = String(r.accountType); acc[k] = (acc[k] ?? 0) + 1; return acc }, {})
out.removedOnPlatform = records.filter(r => r.removedOnPlatform === true).length

// 记录里的互动数 vs metrics.json（同一作品必须一致）
const metricByWork = new Map(metrics.map(m => [String(m.workId), m]))
out.metricMismatches = []
for (const r of records) {
  const m = metricByWork.get(String(r.platformWorkId ?? ''))
  if (!m) continue
  for (const key of ['viewCount', 'likeCount', 'commentCount', 'shareCount', 'favoriteCount']) {
    const left = Number(r[key] ?? 0)
    const right = Number(m[key] ?? 0)
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right)
      out.metricMismatches.push({ recordId: r.id, workId: r.platformWorkId, key, record: left, metric: right })
  }
}

// 数据中心接口 vs 记录/指标求和
const publishedRecords = records.filter(r => r.status === 1 && r.removedOnPlatform !== true)
const overall = dashboard.data?.overall ?? dashboard.data?.summary ?? null
out.dashboardOverall = overall
out.computed = {
  publishedWorkCount: publishedRecords.length,
  sumView: publishedRecords.reduce((acc, r) => acc + Number(r.viewCount ?? 0), 0),
  sumLike: publishedRecords.reduce((acc, r) => acc + Number(r.likeCount ?? 0), 0),
  sumComment: publishedRecords.reduce((acc, r) => acc + Number(r.commentCount ?? 0), 0),
}

// 单账号 analytics：接口值必须等于落库值
out.analytics = []
for (const a of accounts.slice(0, 3)) {
  const res = await api('api/v2/channels/accounts/' + a.id + '/analytics')
  out.analytics.push({
    id: a.id,
    http: res.http,
    code: res.code,
    apiFans: res.data?.fansCount,
    diskFans: a.fansCount,
    apiWork: res.data?.workCount,
    diskWork: a.workCount,
    apiLoginState: res.data?.loginState,
    syncNote: res.data?.syncNote ?? '',
  })
}

console.log(JSON.stringify(out, null, 2))
