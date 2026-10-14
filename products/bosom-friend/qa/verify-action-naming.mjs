#!/usr/bin/env node
/**
 * 动作叫法一致门禁（对标基线的 F6：同一动作在不同对象上叫法、位置、反馈一致）。
 *
 * 为什么需要它：对象级 AI 动作由后端规格表（server/src/object-actions.ts）与前端按钮两侧组成，
 * 两边靠**动作 id 字符串**对齐——没有任何类型把它们绑在一起。改一次 id 或文案，两边不会同时报错：
 * 前端多写一个不存在的 id，接口如实回「不认识这个动作」，用户看到的是点了没反应。
 * 结构上它盯三件事：
 *   ① 规格齐全：每条规格都带 id / kind / label，id 唯一，且 id 以自己所属对象种类开头（叫法跟着对象走）；
 *   ② 文案一致：所有 label 用同一个前缀与格式（`AI ` 开头、无首尾空白、无结尾标点、长度可控），
 *      同一个文案不许指向两条不同动作；
 *   ③ 前端只引用存在的动作：前端源码里写死的 `action: '<id>'` 必须在规格表里登记。
 *
 * 用法：node products/bosom-friend/qa/verify-action-naming.mjs
 * 退出码：0 = 一致；1 = 有缺口（点名动作与文件）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const productRoot = resolve(here, '..')
const SPEC_FILE = join(productRoot, 'server', 'src', 'object-actions.ts')
const WEB_SRC = join(productRoot, 'project', 'bosom-friend-web', 'src')

/** 按钮文案的统一前缀与长度上限：同一排按钮里长短差太远，界面就看不出是一类动作。 */
const LABEL_PREFIX = 'AI '
const LABEL_MAX_CHARS = 12

const issues = []
const spec = readFileSync(SPEC_FILE, 'utf8')
/** 规格块固定写成 id / kind / label 三行，按这个顺序解析；格式漂了会在①里报出来。 */
const specs = [...spec.matchAll(/id: '([^']+)',\s*\n\s*kind: '([^']+)',\s*\n\s*label: '([^']+)',/g)]
  .map(match => ({ id: match[1], kind: match[2], label: match[3] }))

if (specs.length === 0) issues.push('在 server/src/object-actions.ts 里没有解析到任何动作规格（id/kind/label 三行格式变了？）')

const byId = new Map()
const byLabel = new Map()
for (const item of specs) {
  if (byId.has(item.id)) issues.push('动作 id 重复：' + item.id)
  byId.set(item.id, item)
  if (byLabel.has(item.label)) issues.push('两条动作用同一个文案「' + item.label + '」：' + byLabel.get(item.label) + ' / ' + item.id)
  else byLabel.set(item.label, item.id)
  if (!item.id.startsWith(item.kind + '-')) issues.push('动作 ' + item.id + ' 的 id 没有以对象种类 ' + item.kind + ' 开头（叫法要跟着对象走）')
  if (!item.label.startsWith(LABEL_PREFIX)) issues.push('动作 ' + item.id + ' 的文案「' + item.label + '」没有以「' + LABEL_PREFIX + '」开头')
  if (item.label.trim() !== item.label) issues.push('动作 ' + item.id + ' 的文案首尾有空白：' + JSON.stringify(item.label))
  if (/[：:，,。.；;！!？?、]$/.test(item.label)) issues.push('动作 ' + item.id + ' 的文案以标点结尾：' + item.label)
  if ([...item.label].length > LABEL_MAX_CHARS) issues.push('动作 ' + item.id + ' 的文案超过 ' + LABEL_MAX_CHARS + ' 字：' + item.label)
}

/** 前端写死的动作引用：`action: 'note-polish'` 这类，值里必须带连字符（其它 action 字段是路由名）。 */
const referenced = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { walk(full); continue }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    const text = readFileSync(full, 'utf8')
    text.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(/action:\s*'([a-z0-9]+(?:-[a-z0-9]+)+)'/g)) {
        referenced.push({ file: relative(productRoot, full).replace(/\\/g, '/'), line: index + 1, id: match[1] })
      }
    })
  }
}
if (statSync(WEB_SRC, { throwIfNoEntry: false }) === undefined) issues.push('前端源码目录不存在：' + WEB_SRC)
else walk(WEB_SRC)
for (const hit of referenced) {
  if (!byId.has(hit.id)) issues.push('前端 ' + hit.file + ':' + hit.line + ' 引用了未登记的动作 ' + hit.id)
}

if (issues.length > 0) {
  console.log('ACTION_NAMING FAIL 共 ' + issues.length + ' 处：')
  for (const issue of issues.slice(0, 20)) console.log('  - ' + issue)
  process.exit(1)
}
console.log('ACTION_NAMING PASS specs=' + specs.length + ' referenced=' + referenced.length)
process.exit(0)
