/**
 * qa-docsync.mjs - Guard 固定步骤：文档自动同步
 * 读取 qa-guard / qa-guard2 落盘结果，幂等更新 QA 报告（标记块替换，绝不重复堆叠）。
 * 用法：node qa-docsync.mjs   （qa-all.mjs 会自动调用；也可单独运行）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = dirname(fileURLToPath(import.meta.url))

function readResult(file) {
  const p = join(BASE, file)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/** 生成 Guard 结果摘要块 */
function guardSummaryBlock(rs) {
  if (!rs) return '_（无运行记录——请先运行 qa-guard / qa-guard2）_'
  const fails = rs.items.filter(i => !i.pass)
  const line = '- **' + rs.name + '**：' + rs.pass + '/' + rs.total + ' 通过' + (fails.length ? ' — **BLOCKED**' : ' — 全绿') + '（运行于 ' + rs.runAt.slice(0, 19) + '）'
  const failLines = fails.length ? fails.map(f => '  - FAIL `' + f.n + '`' + (f.d ? ' :: ' + f.d : '')).join('\n') : ''
  return line + (failLines ? '\n' + failLines : '')
}

/** 幂等替换标记块（不存在则追加） */
function upsertBlock(file, marker, content) {
  const p = join(BASE, file)
  const start = '<!-- ' + marker + '-START -->'
  const end = '<!-- ' + marker + '-END -->'
  let s = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const block = start + '\n' + content + '\n' + end
  const existingStart = s.indexOf(start)
  const existingEnd = s.indexOf(end)
  if (existingStart >= 0 && existingEnd > existingStart) {
    s = s.slice(0, existingStart) + block + '\n' + s.slice(existingEnd + end.length)
  } else {
    s = s.replace(/\s*$/, '') + '\n\n' + block + '\n'
  }
  writeFileSync(p, s)
  return true
}

// 0) 若结果文件不存在，先跑门禁（保证同步的是最新状态）
import { spawnSync } from 'node:child_process'
if (!existsSync(join(BASE, 'last-guard1.json'))) {
  spawnSync('node', [join(BASE, 'qa-guard.mjs')], { stdio: 'inherit', cwd: BASE })
}
if (!existsSync(join(BASE, 'last-guard2.json'))) {
  spawnSync('node', [join(BASE, 'qa-guard2.mjs')], { stdio: 'inherit', cwd: BASE })
}

// 1) 读结果
const g1 = readResult('last-guard1.json')
const g2 = readResult('last-guard2.json')

// 判红（2026-10-12 收敛，见 task-8）：以前无论同步成没成都 exit 0，被 qa-all 当通过。
// 无信号不等于 0：两份 guard 结果都读不到（文件缺失或内容坏了），就没有真实门禁状态可同步。
if (g1 === null && g2 === null) {
  console.log('QA_DOCSYNC_FAIL last-guard1.json / last-guard2.json 都读不到或内容损坏，没有真实门禁状态可同步')
  process.exit(1)
}

// 2) 同步三份报告：任何一份写不进去都判红（写失败以前完全看不出来）
const g2Block = ['## 最新状态（自动同步）', '', guardSummaryBlock(g2), ''].join('\n')
const fullBlock = ['## 九、门禁自动同步（Guard 固定步骤）', '', guardSummaryBlock(g1), guardSummaryBlock(g2), ''].join('\n')
const visBlock = ['## 视觉门禁（自动同步）', '', guardSummaryBlock(g2), ''].join('\n')
const TARGETS = [
  ['GUARD2_REPORT.md', 'QA-LATEST-STATUS', g2Block],
  ['FULL_QA_REPORT.md', 'QA-GATE-SYNC', fullBlock],
  ['VISUAL_REPORT.md', 'QA-VISUAL-SYNC', visBlock],
]
let written = 0
for (const [file, marker, content] of TARGETS) {
  try { upsertBlock(file, marker, content); written += 1 }
  catch (e) { console.log('QA_DOCSYNC_FAIL 写 ' + file + ' 失败：' + String(e?.message ?? e)) }
}
console.log('qa-docsync: 报告已自动同步（GUARD2/FULL/VISUAL 三份）')
console.log('  G1 =', g1 ? g1.pass + '/' + g1.total : '无记录', '| G2 =', g2 ? g2.pass + '/' + g2.total : '无记录')
if (written < TARGETS.length) {
  console.log('QA_DOCSYNC_FAIL 只有 ' + written + '/' + TARGETS.length + ' 份报告写成功')
  process.exit(1)
}
console.log('QA_DOCSYNC_OK 三份报告已同步')
