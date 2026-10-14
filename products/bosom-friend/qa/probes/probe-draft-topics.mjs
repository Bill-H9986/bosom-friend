/**
 * 草稿「AI 生成话题」端到端探针（ADR-004 §2.2 点名的草稿动作之二）。
 *
 * 要验的是**契约放宽之后的真实行为**：话题是列表字段，写回的是数组，
 * 而不是"把数组拼成字符串写进去"——后者在落盘里看着像成功，读到的时候类型就不对了。
 *
 * 用法：node products/bosom-friend/qa/probes/probe-draft-topics.mjs [baseUrl] [标题] [正文] [--create-only]
 * `--create-only` 只建草稿：页面级验收要的是"这条还没有话题"，这样点的才是第一次写入。
 */
const base = process.argv[2] ?? 'http://127.0.0.1:31280/bosom-friend/api'

const post = async (path, body) => (await fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json()
const get = async (path) => (await fetch(base + path)).json()

const title = process.argv[3] ?? '探针草稿：夏日特调三种做法'
const desc = process.argv[4] ?? '三种在家就能做的夏日特调，材料都在楼下便利店能买到。'
const created = await post('/contents/drafts', { groupId: 'mg-persist', title, desc, mediaList: [] })
if (created.code !== 0) throw new Error('建草稿失败：' + created.message)
const id = String(created.data?._id ?? created.data?.id ?? '')
console.log('CREATED id=' + id)
if (process.argv.includes('--create-only')) process.exit(0)

const actions = await get('/ai/object-actions?kind=draft')
console.log('ACTIONS=' + (actions.data.list ?? []).map(item => item.id + '/' + item.label + '/' + item.field).join(', '))

const started = Date.now()
const action = await post('/ai/object-action', { kind: 'draft', id, action: 'draft-topics' })
const seconds = ((Date.now() - started) / 1000).toFixed(1)
if (action.code !== 0) throw new Error('生成话题失败：' + action.message + ' | 原始响应：' + JSON.stringify(action).slice(0, 400))
console.log('ACTION code=0 secs=' + seconds + ' field=' + action.data.field)
console.log('VALUE_IS_ARRAY=' + Array.isArray(action.data.value))
console.log('VALUE=' + JSON.stringify(action.data.value))

const after = (await get('/contents/' + id)).data
console.log('DISK_TOPICS=' + JSON.stringify(after.topics))
console.log('DISK_TOPICS_IS_ARRAY=' + Array.isArray(after.topics))
console.log('TITLE_INTACT=' + (after.title === title))
console.log('DESC_INTACT=' + (after.desc === desc))
console.log('STAMP_PRESENT=' + (typeof after.updatedAt === 'string' && !Number.isNaN(Date.parse(after.updatedAt))))
