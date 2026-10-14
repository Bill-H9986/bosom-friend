/**
 * 草稿「AI 合规检查」端到端探针（ADR-004 §2.2 点名的第三个草稿动作）。
 *
 * 这个动作**不改内容、只给判断**，所以探针验的是两件事：
 * ① 结论真的写回了这条草稿（aiCompliance）；
 * ② 标题与正文**一个字都没动**——合规检查不是"顺手帮你改一遍"。
 *
 * 用法：node products/bosom-friend/qa/probes/probe-draft-compliance.mjs [baseUrl]
 */
const base = process.argv.slice(2).find(arg => arg.startsWith('http')) ?? 'http://127.0.0.1:31280/bosom-friend/api'

const post = async (path, body) => (await fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json()

// 故意写一条"平台大概率会拒"的草稿：绝对化用语 + 功效承诺 + 索要联系方式。
const title = '最好用的减肥神器，全网第一'
const desc = '七天包瘦，不瘦退款；加微信 xxx 领内部资料。'
const created = await post('/contents/drafts', { groupId: 'mg-persist', title, desc, mediaList: [], accountTypes: ['xhs'] })
const id = String(created.data?._id ?? '')
console.log('CREATED id=' + id)

const actions = await (await fetch(base + '/ai/object-actions?kind=draft')).json()
console.log('ACTIONS=' + (actions.data.list ?? []).map(item => item.id).join(', '))

const started = Date.now()
const res = await post('/ai/object-action', { kind: 'draft', id, action: 'draft-compliance' })
console.log('ACTION code=' + res.code + ' secs=' + ((Date.now() - started) / 1000).toFixed(1) + ' field=' + res.data?.field)
console.log('VERDICT=' + String(res.data?.value ?? res.message ?? '').slice(0, 400))

const after = (await (await fetch(base + '/contents/' + id)).json()).data
console.log('TITLE_INTACT=' + (after.title === title))
console.log('DESC_INTACT=' + (after.desc === desc))
console.log('COMPLIANCE_WRITTEN=' + (typeof after.aiCompliance === 'string' && after.aiCompliance.length > 0))
