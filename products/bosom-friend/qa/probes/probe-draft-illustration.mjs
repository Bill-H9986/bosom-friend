/**
 * 草稿「AI 配图建议」端到端探针（ADR-004 §2.2 点名的最后一个动作）。
 *
 * 验的是"建议有没有落在**用户自己的素材**上"：素材库里的图必须进事实（点名），
 * 库里空着时要如实说"需要补拍"，而不是凭空描述几张图。
 *
 * 用法：node products/bosom-friend/qa/probes/probe-draft-illustration.mjs [baseUrl] [--seed-library]
 */
import { requireWritableDataRoot } from '../lib/data-root.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = process.argv.slice(2).find(arg => arg.startsWith('http')) ?? 'http://127.0.0.1:31280/bosom-friend/api'
const contentsFile = requireWritableDataRoot('探针写入草稿做配图验证') + '/contents.json'

const readRows = () => {
  const parsed = JSON.parse(readFileSync(contentsFile, 'utf8'))
  return Array.isArray(parsed) ? parsed : (parsed.value ?? [])
}
const writeRows = (rows) => {
  writeFileSync(contentsFile, JSON.stringify({ schemaVersion: 1, value: rows }, null, 2), 'utf8')
}

const post = async (path, body) => (await fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json()

// 素材库里放两张**有名字**的探针图：配图建议要能点名它们（没有名字的资产点了也没用）。
if (process.argv.includes('--seed-library')) {
  const rows = readRows().filter(row => !String(row._id).startsWith('asset-probe-'))
  writeRows([...rows,
    { kind: 'asset', _id: 'asset-probe-1', title: '成品俯拍：三杯饮品并排', type: 'img', url: '/bosom-friend/api/assets/file/probe-1.png', thumbUrl: '', groupId: 'mg-persist', useCount: 0 },
    { kind: 'asset', _id: 'asset-probe-2', title: '材料平铺：柠檬与薄荷', type: 'img', url: '/bosom-friend/api/assets/file/probe-2.png', thumbUrl: '', groupId: 'mg-persist', useCount: 0 },
  ])
  console.log('SEEDED library assets=2 total=' + (rows.length + 2))
  process.exit(0)
}

const title = '探针草稿：夏日特调三种做法'
const created = await post('/contents/drafts', { groupId: 'mg-persist', title, desc: '三种在家就能做的夏日特调，材料楼下便利店就能买到。', mediaList: [] })
const id = String(created.data?._id ?? '')
console.log('CREATED id=' + id)

const actions = await (await fetch(base + '/ai/object-actions?kind=draft')).json()
console.log('ACTIONS=' + (actions.data.list ?? []).map(item => item.id).join(', '))

const started = Date.now()
const res = await post('/ai/object-action', { kind: 'draft', id, action: 'draft-illustration' })
console.log('ACTION code=' + res.code + ' secs=' + ((Date.now() - started) / 1000).toFixed(1) + ' field=' + res.data?.field)
console.log('SUGGESTION=' + String(res.data?.value ?? res.message ?? '').slice(0, 500))

const after = readRows().find(row => row._id === id)
console.log('TITLE_INTACT=' + (after.title === title))
console.log('SUGGESTION_WRITTEN=' + (typeof after.aiIllustration === 'string' && after.aiIllustration.length > 0))
// 建议里应当出现库里那两张图的名字之一（证明它真的看了库）。
const text = String(after.aiIllustration ?? '')
console.log('MENTIONS_LIBRARY_ASSET=' + (text.includes('俯拍') || text.includes('平铺')))
