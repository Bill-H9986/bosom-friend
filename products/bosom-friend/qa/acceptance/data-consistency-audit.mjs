/**
 * 数据一致性审计（只读，不写任何数据）。
 *
 * 覆盖两类问题：
 *  1. 内容侧：前端有数据/后端没有、生成成功但拿不到图视频、账号资料是假的或旧的；
 *  2. 账号数据侧：账号库 ↔ 发布记录 ↔ 互动指标 ↔ 数据中心接口 四者必须对得上。
 *
 * 落库文件是 {schemaVersion, value:[...]} 信封：早期版本按裸数组解析，结果所有计数恒为 0，
 * 审计静默空转。这里解析不出数组即记为 format-error 并判失败。
 *
 * 用法：node qa/acceptance/data-consistency-audit.mjs [--json]
 * 退出码：0 = 全部通过；1 = 有失败项（可直接接入门禁）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = process.env.BF_QA_DATA_ROOT || join(homedir(), '.bosom-friend', 'bosom-friend')
const asJson = process.argv.includes('--json')
const failures = []

/** 读取信封落库文件，返回 {name, format, items}。 */
function read(name) {
  const path = join(root, name)
  if (!existsSync(path))
    return { name, format: 'missing', items: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(parsed))
      return { name, format: 'raw-array', items: parsed }
    if (Array.isArray(parsed.value))
      return { name, format: 'envelope', items: parsed.value }
    failures.push(name + ': 既不是数组也不是 {schemaVersion, value:[]} 信封')
    return { name, format: 'invalid', items: [] }
  }
  catch (error) {
    failures.push(name + ': 解析失败 ' + String(error))
    return { name, format: 'parse-error', items: [] }
  }
}

/** 读取单对象配置文件（如 llm-user.json）：这类文件本来就不是信封。 */
function readObject(name) {
  const path = join(root, name)
  if (!existsSync(path))
    return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  }
  catch (error) {
    failures.push(name + ': 解析失败 ' + String(error))
    return {}
  }
}

const accountsFile = read('accounts.json')
const recordsFile = read('publish-records.json')
const metricsFile = read('metrics.json')
const gensFile = read('draft-generations.json')
const contentsFile = read('contents.json')
const tasksFile = read('agent-tasks.json')
const logsFile = read('ai-logs.json')
const llmConfig = readObject('llm-user.json')

const accounts = accountsFile.items
const records = recordsFile.items
const metrics = metricsFile.items
const gens = gensFile.items
const media = contentsFile.items.filter(item => item.kind === 'asset')
const tasks = tasksFile.items

// ---- 内容侧：生成成功的媒体必须真的落盘且登记在素材库 -------------------------------------
const assetUrls = new Set()
for (const gen of gens) {
  for (const url of [...(gen.response?.imageUrls ?? []), gen.response?.videoUrl, gen.response?.coverUrl]) {
    if (typeof url === 'string' && url) assetUrls.add(url)
  }
}
const mediaUrls = new Set(media.map(item => item.url).filter(Boolean))
const missingFromMedia = [...assetUrls].filter(url => !mediaUrls.has(url))
const missingFiles = [...assetUrls].filter((url) => {
  const id = decodeURIComponent(url.split('/').pop() || '')
  return !existsSync(join(root, 'uploads', id))
})
const noMediaSuccess = gens.filter(gen => gen.status === 'success' && !((gen.response?.imageUrls?.length ?? 0) > 0 || gen.response?.videoUrl || gen.response?.coverUrl))
const failedTextSuccess = gens.filter(gen => gen.status === 'success' && /调用失败|未知错误|失败|错误/.test(String(gen.response?.description ?? '')))
if (missingFromMedia.length > 0) failures.push('生成媒体没有登记进素材库：' + missingFromMedia.length + ' 个')
if (missingFiles.length > 0) failures.push('生成成功的媒体文件缺失：' + missingFiles.length + ' 个')
if (noMediaSuccess.length > 0) failures.push('生成成功但没有媒体：' + noMediaSuccess.length + ' 条')
if (failedTextSuccess.length > 0) failures.push('生成成功但描述里是失败：' + failedTextSuccess.length + ' 条')

// ---- 账号数据侧：账号库 ↔ 记录 ↔ 指标 ↔ 接口 --------------------------------------------
const accountIds = new Set(accounts.map(account => account.id))
const orphanRecords = records.filter(record => !accountIds.has(record.accountId))
const orphanMetrics = metrics.filter(metric => !accountIds.has(metric.accountId))
if (orphanRecords.length > 0) failures.push('发布记录指向不存在的账号：' + orphanRecords.length + ' 条')
if (orphanMetrics.length > 0) failures.push('互动指标指向不存在的账号：' + orphanMetrics.length + ' 条')

const publishedRecords = records.filter(record => record.status === 1 && record.removedOnPlatform !== true)
const missingEvidence = publishedRecords.filter(record => !record.platformWorkId || !record.workLink || !record.publishTime)
if (missingEvidence.length > 0) failures.push('已发布记录缺作品证据：' + missingEvidence.length + ' 条')

const workIds = records.map(record => String(record.platformWorkId ?? '')).filter(id => id !== '')
const duplicated = [...new Set(workIds.filter((id, index) => workIds.indexOf(id) !== index))]
if (duplicated.length > 0) failures.push('同一平台作品登记了多条记录：' + duplicated.length + ' 个')

const metricByWork = new Map(metrics.map(metric => [String(metric.workId), metric]))
const engagementMismatches = []
for (const record of records) {
  const metric = metricByWork.get(String(record.platformWorkId ?? ''))
  if (metric === undefined) continue
  for (const key of ['viewCount', 'likeCount', 'commentCount', 'shareCount', 'favoriteCount']) {
    const fromRecord = Number(record.engagement?.[key] ?? 0)
    const fromMetric = Number(metric[key] ?? 0)
    if (fromRecord !== fromMetric) engagementMismatches.push(record.id + '.' + key + ' ' + fromRecord + '≠' + fromMetric)
  }
}
if (engagementMismatches.length > 0) failures.push('记录 engagement 与 metrics 不一致：' + engagementMismatches.length + ' 处')

for (const account of accounts) {
  const mine = records.filter(record => record.accountId === account.id)
  if (mine.length !== account.workCount) failures.push('账号 ' + account.id + ' workCount=' + String(account.workCount) + ' 与记录数 ' + mine.length + ' 不一致')
}

// ---- 汇总 ---------------------------------------------------------------------------------
const views = metrics.reduce((sum, metric) => sum + Number(metric.viewCount ?? 0), 0)
const report = {
  generatedAt: new Date().toISOString(),
  root,
  formats: { accounts: accountsFile.format, records: recordsFile.format, metrics: metricsFile.format },
  counts: {
    accounts: accounts.length,
    publishRecords: records.length,
    publishedRecords: publishedRecords.length,
    metrics: metrics.length,
    generations: gens.length,
    media: media.length,
    tasks: tasks.length,
    logs: logsFile.items.length,
    assetRefs: assetUrls.size,
    missingFromMedia: missingFromMedia.length,
    missingFiles: missingFiles.length,
    noMediaSuccess: noMediaSuccess.length,
    failedTextSuccess: failedTextSuccess.length,
    orphanRecords: orphanRecords.length,
    orphanMetrics: orphanMetrics.length,
    engagementMismatches: engagementMismatches.length,
    totalViews: views,
  },
  accounts: accounts.map(account => ({
    id: account.id,
    type: account.type,
    nickname: account.nickname,
    fansCount: account.fansCount,
    workCount: account.workCount,
    records: records.filter(record => record.accountId === account.id).length,
    loginState: account.loginState ?? null,
  })),
  failures,
  llmConfigured: typeof llmConfig.apiKey === 'string' ? llmConfig.apiKey.trim() !== '' : false,
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
}
else {
  console.log('数据一致性审计 @ ' + report.generatedAt)
  console.log('落库格式: accounts=' + report.formats.accounts + ' records=' + report.formats.records + ' metrics=' + report.formats.metrics)
  console.log('计数: ' + JSON.stringify(report.counts))
  console.log('账号: ' + report.accounts.map(account => account.nickname + '(' + account.type + '/' + account.records + '条/' + account.fansCount + '粉)').join(', '))
  console.log(failures.length === 0 ? 'DATA_CONSISTENCY PASS' : 'DATA_CONSISTENCY FAIL:\n  - ' + failures.join('\n  - '))
}
process.exit(failures.length === 0 ? 0 : 1)
