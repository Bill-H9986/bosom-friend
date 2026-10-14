/**
 * 复利飞轮的真模型探针：**上一次被认可的产出，真的出现在下一次的提示词里**（ADR-004 S4）。
 *
 * 检验方式不是"接口回了 code 0"，而是回到**账本自己身上**：账本记的是每次调用真实送进模型的提示词，
 * 所以"第二次的 instruction 里有没有第一次的 output"是自证的——不需要额外的埋点。
 *
 * 用法：node products/bosom-friend/qa/probes/probe-quality-loop.mjs [baseUrl]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:31280/bosom-friend/api'
const knowledgeFile = join(homedir(), '.bosom-friend', 'bosom-friend', 'knowledge.json')

const post = async (path, body) => (await fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json()

/**
 * 读账本（带 schema 信封）。
 *
 * @returns 全部蒸馏样本。
 */
const readSamples = () => {
  const parsed = JSON.parse(readFileSync(knowledgeFile, 'utf8'))
  const state = Array.isArray(parsed) ? { distillations: parsed } : (parsed.value ?? parsed)
  return state.distillations ?? []
}

const title = '探针草稿：飞轮第二圈'
const created = await post('/contents/drafts', { groupId: 'mg-persist', title, desc: '复利探针用草稿，可删。', mediaList: [] })
const id = String(created.data?._id ?? '')
console.log('CREATED id=' + id)
const sourceId = 'object-action-draft-' + id + '-draft-title'

const first = await post('/ai/object-action', { kind: 'draft', id, action: 'draft-title' })
console.log('RUN1 code=' + first.code + ' value=' + first.data?.value)
const sample = readSamples().find(item => item.sourceId === sourceId)
if (sample === undefined) throw new Error('第一次跑完账本里应该有样本')
console.log('SAMPLE1 id=' + sample.id + ' rating=' + sample.rating)

const rated = await post('/knowledge/distill/rate', { id: sample.id, rating: 5 })
console.log('RATED ok=' + rated.data?.ok)

const second = await post('/ai/object-action', { kind: 'draft', id, action: 'draft-title' })
console.log('RUN2 code=' + second.code + ' value=' + second.data?.value)
const rows = readSamples().filter(item => item.sourceId === sourceId)
console.log('SAME_SOURCE_ROWS=' + rows.length)
console.log('RATING_KEPT=' + rows.some(item => item.rating === 5))

// 账本记的 `instruction` 只是动作提示词本身；**注入的语境是按 id 另记的**（exampleIds），
// 所以"这次的上下文里带了哪几条样例"要读 exampleIds，而不是在 instruction 里找样例文本。
// 这也正是"模型看得见的东西必须留痕"那条规矩的用处：复利不需要另加埋点，账本自己就能证明。
const run2 = rows.find(item => item.id.endsWith('-2')) ?? rows[0]
const run1 = rows.find(item => item.id === sample.id)
const exampleIds = Array.isArray(run2.exampleIds) ? run2.exampleIds : []
console.log('RUN2_EXAMPLE_IDS=' + JSON.stringify(exampleIds))
console.log('RUN2_CONTEXT_INCLUDES_RUN1=' + exampleIds.includes(run1.id))
const run1Example = readSamples().find(item => item.id === exampleIds[0])
if (run1Example !== undefined) {
  console.log('INJECTED_OUTPUT=' + String(run1Example.output).slice(0, 60))
  console.log('INJECTED_RATING=' + run1Example.rating)
}
