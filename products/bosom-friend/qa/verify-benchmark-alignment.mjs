#!/usr/bin/env node
/**
 * 对标看齐门禁：让「飞书 × 豆包工作」这条方向**不会随时间跑偏**。
 *
 * 为什么需要它：方向类文档最容易变成一次性的宣言——写完没人再看，新功能也不再声明自己对标什么。
 * 本门禁检查四件事：
 *   ① 基线文档存在；② 判据齐全（F1–F6 / D1–D6 / E1–E3 每条都在差距矩阵里有状态标记）；
 *   ③ 关键文档（开发报告 / 功能清单 / RTM / 执行档案）各自带一段「对标定位」并链接基线；
 *   ④ 基线里不出现未定义的状态词（只认 ✅ / 🟡 / ⛔），免得矩阵变成自由文本。
 *
 * 用法：node products/bosom-friend/qa/verify-benchmark-alignment.mjs
 * 退出码：0 = 看齐；1 = 有缺口（点名文件与判据）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const productRoot = join(here, '..')
const docs = join(productRoot, 'docs')
const BASELINE = join(docs, '对标基线-飞书×豆包工作.md')

const CRITERIA = [
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6',
  'E1', 'E2', 'E3',
]
/** 必须带「对标定位」的关键文档（相对 docs）。 */
const ALIGNED = [
  '开发报告.md',
  '功能清单-三大核心功能.md',
  join('trace', 'RTM.md'),
  join('过程档案', '方案与路线', '飞书×豆包-深度优化执行方案.md'),
]

const issues = []
if (!existsSync(BASELINE)) {
  console.log('BENCHMARK_ALIGNMENT FAIL 缺少基线文档：' + BASELINE)
  process.exit(1)
}
const baseline = readFileSync(BASELINE, 'utf8')

// ② 每条判据都要在矩阵里出现，且该行带状态标记
const matrixStart = baseline.indexOf('## 3. 差距矩阵')
if (matrixStart < 0) issues.push('基线里找不到「## 3. 差距矩阵」小节')
const matrix = matrixStart < 0 ? '' : baseline.slice(matrixStart)
for (const id of CRITERIA) {
  if (!new RegExp('\\*\\*' + id + '|\\| ' + id + ' ').test(baseline)) issues.push('基线里没有定义判据 ' + id)
  const row = matrix.split(/\r?\n/).find(l => l.startsWith('| ' + id + ' ') || l.startsWith('| **' + id + ' '))
  if (row === undefined) issues.push('差距矩阵缺 ' + id + ' 这一行')
  else if (!/[✅🟡⛔]/.test(row)) issues.push('差距矩阵里 ' + id + ' 这一行没有状态标记（✅ / 🟡 / ⛔）')
}

// ③ 关键文档必须声明对标定位，并链接基线
let aligned = 0
for (const rel of ALIGNED) {
  const file = join(docs, rel)
  if (!existsSync(file)) { issues.push('关键文档不存在：docs/' + rel); continue }
  const text = readFileSync(file, 'utf8')
  if (!text.includes('对标定位')) { issues.push('docs/' + rel + ' 缺「对标定位」段（写法见基线 §4）'); continue }
  if (!text.includes('对标基线-飞书×豆包工作.md')) { issues.push('docs/' + rel + ' 的「对标定位」没有链接基线文档'); continue }
  aligned += 1
}

// ④ 状态词只认三种，防止矩阵退化成自由文本
const statusCells = matrix.split(/\r?\n/).filter(l => /^\| (\*\*)?[FDE]\d/.test(l)).map(l => l.split('|')[2] ?? '')
for (const [i, cell] of statusCells.entries()) {
  const marks = cell.match(/[✅🟡⛔]/gu) ?? []
  if (marks.length !== 1) issues.push('差距矩阵第 ' + (i + 1) + ' 行的状态列应为**恰好一个**状态标记，实际 ' + JSON.stringify(cell.trim()))
}

if (issues.length > 0) {
  console.log('BENCHMARK_ALIGNMENT FAIL 共 ' + issues.length + ' 处：')
  for (const issue of issues.slice(0, 20)) console.log('  - ' + issue)
  process.exit(1)
}
console.log('BENCHMARK_ALIGNMENT PASS criteria=' + CRITERIA.length + ' aligned_docs=' + aligned + ' matrix_rows=' + statusCells.length)
process.exit(0)
