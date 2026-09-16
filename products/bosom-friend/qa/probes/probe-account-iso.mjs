// probe-account-iso.mjs - 账号矩阵隔离端到端
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const H = { Authorization: 'Bearer x', 'Content-Type': 'application/json' }
const j = async (m, p, b) => { const r = await fetch('http://127.0.0.1:3081/bosom-friend/api/' + p, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) }); return [r.status, await r.json()] }
// 1) 两账号
const [ , a1 ] = await j('POST', 'v2/channels/accounts', { type: 'xhs', nickname: '矩阵号A·小红书' })
const [ , a2 ] = await j('POST', 'v2/channels/accounts', { type: 'douyin', nickname: '矩阵号B·抖音' })
console.log('accounts:', a1.data.id, a2.data.id)
// 2) 基于现有记录克隆两条（A/B 各一），落盘模拟矩阵历史数据
const fs = await import('node:fs')
const recPath = process.env.USERPROFILE + '/.bosom-friend/bosom-friend/publish-records.json'
const recs = JSON.parse(fs.readFileSync(recPath, 'utf8'))
const tmpl = recs.find(r => r.status === 1)
const mk = (accountId, accountType, title, id) => ({ ...JSON.parse(JSON.stringify(tmpl || {})), id, accountId, accountType, title, status: 1, publishTime: new Date().toISOString(), viewCount: 0, likeCount: 0, commentCount: 0, shareCount: 0 })
const idA = 'rec-matrix-a'
const idB = 'rec-matrix-b'
recs.unshift(mk(a1.data.id, 'xhs', 'A号笔记', idA), mk(a2.data.id, 'douyin', 'B号视频', idB))
fs.writeFileSync(recPath, JSON.stringify(recs, null, 2))
console.log('seeded:', recs.length, 'records')
// 3) 数据中心按账号筛选：全部 vs A vs B
const dAll = await (await fetch('http://127.0.0.1:3081/bosom-friend/api/v2/statistics/published-content-summary/dashboard', { headers: H })).json()
const dA = await (await fetch('http://127.0.0.1:3081/bosom-friend/api/v2/statistics/published-content-summary/dashboard?accountId=' + a1.data.id, { headers: H })).json()
const dB = await (await fetch('http://127.0.0.1:3081/bosom-friend/api/v2/statistics/published-content-summary/dashboard?accountId=' + a2.data.id, { headers: H })).json()
console.log('DASH all=', dAll.data.overall.workCount, 'A=', dA.data.overall.workCount, 'B=', dB.data.overall.workCount)
// 4) 专属规则：A 账号专属命中 vs B 不命中
const [ , rule ] = await j('POST', 'v2/customer-reception/rules', { name: 'A号专属报价', accountId: a1.data.id, platforms: ['xhs'], keywords: ['发货'], replyMode: 'template', template: 'A号专属：您好！', priority: 1 })
const [ , hitA ] = await j('POST', 'v2/customer-reception/test', { message: '什么时候发货', accountId: a1.data.id })
const [ , hitB ] = await j('POST', 'v2/customer-reception/test', { message: '什么时候发货', accountId: a2.data.id })
console.log('RULE hitA=', hitA.data?.matched, hitA.data?.reply, '| hitB=', hitB.data?.matched, hitB.data?.reply)
// 5) 级联删除 A：A 记录消失、B 记录保留
const [ , del ] = await j('DELETE', 'v2/channels/accounts/' + a1.data.id)
const [ , recList ] = await j('GET', 'v2/channels/publish/records')
console.log('DELETE A=', del.data, 'records after=', recList.data.records.length, 'ids=', recList.data.records.map(x => x.accountId).join(','))
