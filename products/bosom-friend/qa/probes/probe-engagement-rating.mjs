/**
 * 用发布后的真实表现给样本打分的真模型探针（ADR-004 附录 P1）。
 *
 * 两步：
 *   node products/bosom-friend/qa/probes/probe-engagement-rating.mjs --seed
 *   （重启开发态运行时，让"语境刷新"跑一次）→
 *   node products/bosom-friend/qa/probes/probe-engagement-rating.mjs
 *
 * **诚实说明**：探针**种不出真实的平台数据**——播放量只能由真实发布 + 平台采集产生。
 * 所以这里写进 publish-records.json 的 engagement 是探针造的，用来验证整条链的**接线**：
 * 作品 → 它的来源草稿 → 那条草稿上的 AI 样本 → 评分。真实数据到位时跑的是同一段代码。
 */
import { requireWritableDataRoot } from '../lib/data-root.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 第一个参数可能是 URL，也可能直接就是 --seed：按形状认，不按位置认。
const base = process.argv.slice(2).find(arg => arg.startsWith('http')) ?? 'http://127.0.0.1:31280/bosom-friend/api'
const seed = process.argv.includes('--seed')
const dataRoot = requireWritableDataRoot('探针写入评分样本做互动评分验证')
const recordsFile = join(dataRoot, 'publish-records.json')
const knowledgeFile = join(dataRoot, 'knowledge.json')

const post = async (path, body) => (await fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json()

/** 读带 schema 信封的 JSON。 */
const readJson = (file) => {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  return Array.isArray(parsed) ? parsed : (parsed.value ?? parsed)
}

const DRAFT_TITLE = '探针草稿：按表现打分的靶子'
const ACCOUNT_ID = 'acc-probe-rating'

async function run() {
if (seed) {
  // 1) 一条草稿 + 一次真实的「AI 改标题」，账本里就会留下一条带 objectKind/objectId 的样本
  const created = await post('/contents/drafts', { groupId: 'mg-persist', title: DRAFT_TITLE, desc: '探针用草稿，可删。', mediaList: [] })
  const draftId = String(created.data?._id ?? '')
  const action = await post('/ai/object-action', { kind: 'draft', id: draftId, action: 'draft-title' })
  console.log('DRAFT=' + draftId + ' ACTION_CODE=' + action.code + ' VALUE=' + action.data?.value)

  // 2) 同一个账号下五条"已发布"作品，只有那条草稿跑赢
  const works = [
    { id: 'probe-rate-1', views: 5000, draftId },
    { id: 'probe-rate-2', views: 900 },
    { id: 'probe-rate-3', views: 700 },
    { id: 'probe-rate-4', views: 500 },
    { id: 'probe-rate-5', views: 300 },
  ]
  const kept = readJson(recordsFile).filter(row => !String(row.id).startsWith('probe-rate-'))
  const seeded = works.map(work => ({
    id: work.id,
    accountId: ACCOUNT_ID,
    accountType: 'xhs',
    type: 'ImageText',
    status: 1,
    title: '探针作品 ' + work.id,
    publishTime: new Date(Date.now() - 86400000).toISOString(),
    platformWorkId: work.id,
    engagement: { viewCount: work.views, likeCount: Math.round(work.views / 50) },
    ...(work.draftId === undefined ? {} : { draftId: work.draftId }),
  }))
  writeFileSync(recordsFile, JSON.stringify({ schemaVersion: 1, value: [...kept, ...seeded] }, null, 2), 'utf8')
  console.log('SEEDED works=' + seeded.length + ' account=' + ACCOUNT_ID)
  // 不用 process.exit(0)：Windows 上还有未关闭的句柄时会踩 libuv 断言（退出码 1 看着像失败）。
  return
}

const samples = readJson(knowledgeFile).distillations ?? []
const target = samples.find(item => item.objectKind === 'draft' && String(item.output).includes('探针'))
  ?? samples.find(item => item.objectKind === 'draft')
if (target === undefined) throw new Error('账本里没有草稿上的样本，先跑 --seed')
console.log('SAMPLE id=' + target.id)
console.log('SAMPLE objectId=' + target.objectId)
console.log('SAMPLE rating=' + target.rating)
console.log('SAMPLE ratingSource=' + (target.ratingSource ?? '(未标)'))
console.log('AUTO_RATED=' + (target.ratingSource === 'engagement' && target.rating >= 4))
const logs = readJson(join(dataRoot, 'ai-logs.json'))
const line = logs.find(entry => entry.kind === 'sample_rating')
console.log('LOG=' + (line === undefined ? '(没有打分日志)' : line.detail))
}

await run()
