#!/usr/bin/env node
/**
 * 缺陷台账的结构检查。
 *
 * 为什么需要它：台账是手写 Markdown 表格，而**没有任何检查看着行的结构**——门禁只验「关闭字段非空」。
 * 2026-09-22 实测：DEF-146 那一行里还塞着一条完整缺陷（只少了 `| DEF-145 |` 前缀），门禁按 `| DEF-` 前缀解析，
 * **那条缺陷从未进过门禁视野**；另有 2 行单元格里带裸竖线，表格被撑成 13～21 列，按位置取字段读到的是邻格的值。
 * 与 DEF-014（台账为空、门禁照样绿）同一族：检查看着表，却不看着表的结构。
 *
 * 判据：① 每行正好 11 格（只数未转义的竖线）；② DEF 编号唯一；③ 状态为关闭态的行，根因/关联REQ/回归用例都非空。
 *
 * 用法：node products/bosom-friend/qa/verify-defect-ledger.mjs [台账路径]
 * 退出码：0 = 结构合规；1 = 有坏行（点名行号与原因）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ledgerPath = process.argv[2] ?? join(here, 'defects', '缺陷台账.md')
const COLUMNS = 11
const CLOSED = new Set(['Fixed', 'Verified', 'Closed'])

/**
 * 状态单元格规范化：`**Fixed**` 与 `Fixed（已验证：…）` 都算关闭态。
 * 不做这一步，带说明的关闭行会被整行跳过——2026-10-12 实测 95 行里只检查了 53 行，
 * 其余「根因 / 关联 REQ / 回归用例非空」的断言从未执行，门禁却报 PASS。
 * @param raw 状态单元格原文
 * @returns 仅剩状态词
 */
function normalizeStatus(raw) {
  return raw.replace(/\*\*/g, '').replace(/[（(].*$/, '').trim()
}

if (!existsSync(ledgerPath)) {
  console.log('DEFECT_LEDGER FAIL reason=missing-ledger path=' + ledgerPath)
  process.exit(1)
}

const issues = []
const ids = new Map()
let checked = 0
for (const [index, row] of readFileSync(ledgerPath, 'utf8').split(/\r?\n/).entries()) {
  if (!/^\s*\|\s*DEF-\d+/.test(row)) continue
  const line = index + 1
  const cells = row.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim())
  const [id, _title, _severity, status, _type, root, req, regression] = cells
  if (ids.has(id)) issues.push('第 ' + line + ' 行：编号 ' + id + ' 重复（另见第 ' + ids.get(id) + ' 行）')
  else ids.set(id, line)
  if (cells.length !== COLUMNS) {
    issues.push('第 ' + line + ' 行（' + id + '）：' + cells.length + ' 格，应为 ' + COLUMNS + ' 格——单元格里的竖线要转义成 \\|，否则按位置取的字段是错位的')
    continue
  }
  if (!CLOSED.has(normalizeStatus(status))) continue
  checked += 1
  if (!root) issues.push('第 ' + line + ' 行（' + id + '）：关闭前缺根因归类')
  if (!req) issues.push('第 ' + line + ' 行（' + id + '）：缺关联 REQ')
  if (!regression) issues.push('第 ' + line + ' 行（' + id + '）：关闭前缺回归用例')
}

if (ids.size === 0) {
  console.log('DEFECT_LEDGER FAIL reason=no-rows —— 台账里没有可校验的缺陷行，空表不等于合规')
  process.exit(1)
}
if (issues.length > 0) {
  console.log('DEFECT_LEDGER FAIL 共 ' + String(issues.length) + ' 处：')
  for (const issue of issues.slice(0, 20)) console.log('  - ' + issue)
  process.exit(1)
}
console.log('DEFECT_LEDGER PASS rows=' + String(ids.size) + ' closed_checked=' + String(checked))
process.exit(0)
