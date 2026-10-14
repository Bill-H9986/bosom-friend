/**
 * 发布记录「AI 复盘」端到端探针（ADR-004 §2.2 点名的第三个对象动作）。
 *
 * 两步，第二步要显式给：
 *   node products/bosom-friend/qa/probes/probe-work-review.mjs --seed   # 往真实数据根种两条**标注为探针**的发布记录
 *   node products/bosom-friend/qa/probes/probe-work-review.mjs          # 对其中一条跑真模型复盘并回读
 *
 * 为什么要把"种数据"单列成一步：真实数据根里一条发布记录都没有（发布链路没跑过），
 * 而页面验收必须看到作品行。探针行统一带 `probe:` 前缀的 id，方便一次性清掉。
 */
import { requireWritableDataRoot } from '../lib/data-root.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:31280/bosom-friend/api'
const seed = process.argv.includes('--seed')
const recordsFile = requireWritableDataRoot('探针写入作品复盘样本') + '/publish-records.json'
const PUBLISHED = 1

/** 探针记录：标题带「探针」二字，用户一眼能认出不是自己的真实作品。 */
const PROBE_RECORDS = [
  {
    id: 'probe-work-review-1',
    accountType: 'xhs',
    type: 'ImageText',
    status: PUBLISHED,
    title: '探针作品：夏日特调三种做法',
    desc: '三种在家就能做的夏日特调',
    publishTime: new Date(Date.now() - 3 * 86400000).toISOString(),
    platformWorkId: 'probe-work-1',
    workLink: 'https://example.com/probe-work-1',
    engagement: { viewCount: 1200, likeCount: 88, commentCount: 7, favoriteCount: 31 },
  },
  {
    id: 'probe-work-review-2',
    accountType: 'xhs',
    type: 'ImageText',
    status: PUBLISHED,
    title: '探针作品：办公室十分钟早餐',
    desc: '十分钟能做完的早餐',
    publishTime: new Date(Date.now() - 1 * 86400000).toISOString(),
    platformWorkId: 'probe-work-2',
    workLink: 'https://example.com/probe-work-2',
    // 缺 viewCount：验证"未采集"不会被当成 0 送进提示词
    engagement: { likeCount: 12, commentCount: 1 },
  },
]

/**
 * 读落盘的发布记录。
 *
 * 文件是**带信封**的 `{schemaVersion, value}`（JsonFile 的统一格式），
 * 直接把整个文件当数组用会得到 undefined —— 探针第一版就是这么错的。
 *
 * @returns 记录数组。
 */
const readRows = () => {
  const parsed = JSON.parse(readFileSync(recordsFile, 'utf8'))
  return Array.isArray(parsed) ? parsed : (parsed.value ?? [])
}

const post = async (path, body) => (await fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json()
const get = async (path) => (await fetch(base + path)).json()

if (seed) {
  const kept = readRows().filter(row => !String(row.id).startsWith('probe-work-review-'))
  // 按服务端自己的信封格式写回去，别让探针在文件里造出第二种结构。
  writeFileSync(recordsFile, JSON.stringify({ schemaVersion: 1, value: [...kept, ...PROBE_RECORDS] }, null, 2), 'utf8')
  console.log('SEEDED probe records=' + PROBE_RECORDS.length + ' total=' + (kept.length + PROBE_RECORDS.length))
  process.exit(0)
}

const actions = await get('/ai/object-actions?kind=work')
console.log('ACTIONS=' + (actions.data.list ?? []).map(item => item.id + '/' + item.label + '/' + item.field).join(', '))

const id = 'probe-work-review-1'
const started = Date.now()
const action = await post('/ai/object-action', { kind: 'work', id, action: 'work-review' })
const seconds = ((Date.now() - started) / 1000).toFixed(1)
if (action.code !== 0) throw new Error('复盘失败：' + action.message)
console.log('ACTION code=0 secs=' + seconds + ' field=' + action.data.field)
console.log('VALUE=' + action.data.value)

const after = readRows().find(row => row.id === id)
console.log('AFTER title=' + after.title + ' viewCount=' + after.engagement.viewCount + ' likeCount=' + after.engagement.likeCount)
console.log('AFTER aiReview=' + after.aiReview)
console.log('AFTER aiReviewAt=' + after.aiReviewAt)
console.log('TITLE_INTACT=' + (after.title === '探针作品：夏日特调三种做法'))
console.log('DATA_INTACT=' + (after.engagement.viewCount === 1200 && after.engagement.likeCount === 88))
console.log('STAMP_PRESENT=' + (typeof after.aiReviewAt === 'string' && !Number.isNaN(Date.parse(after.aiReviewAt))))
