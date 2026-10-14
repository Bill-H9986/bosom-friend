#!/usr/bin/env node
/**
 * 验收单（BFS-903）——给产品负责人看的那一份。
 *
 * 2026-10-12 改名：原叫「交付验收单」。产品负责人要求把「打包」从项目流程里彻底删掉——
 * 打包不是流程的一步，是他下令才做的动作。这份单子验收的是**能力**（一句话能不能把事办成），
 * 不是「有没有出包」。
 *
 * 为什么要有它：产品负责人问「你都没有个验收标准的吗？」——之前所有门禁都是给实现者看的
 * （内核工具 68/68、preset 10/10……），没有一份是「他能拿着逐条打勾」的。
 * 本件把验收拆成三层，**按他的初衷排序**：
 *   第一层 一句话办事（他亲自在 APP 里说一句，看见结果）——**算不算做完，以这层为准**
 *   第二层 管家分工（结构化：工具面即权限、按角色切面）
 *   第三层 质量门禁（结构化：跑得动的自动跑，跑不动的标出来）
 *
 * 用法：
 *   node qa/acceptance-checklist.mjs           跑第三层的快项，输出三层状态
 *   node qa/acceptance-checklist.mjs --slow    连慢项（qa-guard2 / 端到端 13 条）一起跑
 *   node qa/acceptance-checklist.mjs --json    机器可读
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = resolve(HERE, '..')
const slow = process.argv.includes('--slow')
const asJson = process.argv.includes('--json')

const rows = []
function add(layer, id, what, status, evidence) { rows.push({ layer, id, what, status, evidence }) }

// ── 第一层：一句话办事（产品负责人亲自验；写链路必须由他下令，不进自动） ──
add('第一层 · 一句话办事（你亲自验）', 'L1', '对 AI 说「看下草稿箱」→ 它列出草稿（只读，可自动）', 'auto', '跑 verify-one-sentence-e2e 的第 1 条')
add('第一层 · 一句话办事（你亲自验）', 'L2', '说「写一条 XX 的图文」→ 内容落进草稿箱', 'manual', '在 APP 里说一句；写完看草稿箱是否多一条')
add('第一层 · 一句话办事（你亲自验）', 'L3', '说「把这条发到小红书」→ 真发出去并给作品链接', 'manual', '按硬约束 2，必须你明确下令才跑；看发布记录与作品链接')
add('第一层 · 一句话办事（你亲自验）', 'L4', '说「我最近发了哪些」→ 列出发布记录与平台回执', 'auto', '跑 verify-one-sentence-e2e 的发布类条目')

// ── 第二层：管家分工 ──
function run(rel, args = []) {
  const f = join(HERE, rel)
  if (!existsSync(f)) return { ok: false, out: 'missing ' + rel }
  const r = spawnSync(process.execPath, [f, ...args], { cwd: PRODUCT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  return { ok: r.status === 0, out: out.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? '' }
}

// 工具面：逐角色实得工具数（源码与 roles.json 一致性由 preset-parity 守）
const rolesFile = join(PRODUCT, 'presets', 'roles.json')
let roleSummary = '读不到 roles.json'
try {
  const roles = JSON.parse(readFileSync(rolesFile, 'utf8'))
  const names = new Set()
  const stack = [join(PRODUCT, 'kernel', 'src')]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(cur, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (!/\.ts$/.test(e.name)) continue
      let src = ''
      try { src = readFileSync(p, 'utf8') } catch { continue }
      for (const m of src.matchAll(/name:\s*['"](bosom_[a-z0-9_]+)['"]/g)) names.add(m[1])
    }
  }
  const parts = []
  for (const [role, patterns] of Object.entries(roles)) {
    const hit = [...names].filter(n => patterns.some(pt => pt.endsWith('*') ? n.startsWith(pt.slice(0, -1)) : n === pt))
    parts.push(role + ' ' + hit.length)
  }
  roleSummary = parts.join(' / ')
} catch (e) { roleSummary = '计算失败: ' + String(e.message).slice(0, 60) }

add('第二层 · 管家分工', 'R1', '按角色切面：工具面即权限（不是叮嘱）', 'auto', roleSummary)
add('第二层 · 管家分工', 'R2', '没有工具绕过工具面筛选', 'auto', 'verify-kernel-tools 的注册面断言')

// ── 第三层：质量门禁 ──
const fast = [
  ['G1', '内核工具逐条真跑', 'verify-kernel-tools.mjs'],
  ['G2', '管家工具面一致性', 'verify-preset-parity.mjs'],
  ['G3', '缺陷台账结构与闭环', 'verify-defect-ledger.mjs'],
  ['G4', '五项目标方向（覆盖率/前端/用例）', 'verify-marvis-progress.mjs'],
  ['G5', '分区纪律棘轮', 'verify-zone-discipline.mjs'],
  ['G6', '第二份事实漂移', 'verify-drift.mjs'],
  ['G7', '文档门禁', 'verify-docs-standard.mjs'],
]
const slowItems = [
  ['G8', '陌生人之眼（qa-guard2 28 项）', 'qa-guard2.mjs'],
  ['G9', '一句话端到端 13 条（整条工作流，只读）', 'verify-one-sentence-e2e.mjs'],
]
const results = {}
for (const [id, what, file] of fast) {
  const r = run(file)
  results[id] = r.ok
  add('第三层 · 质量门禁', id, what, r.ok ? 'pass' : 'fail', r.out.slice(0, 110))
}
for (const [id, what, file] of slowItems) {
  if (!slow) { add('第三层 · 质量门禁', id, what + '（未跑：加 --slow）', 'skipped', file); continue }
  const r = run(file)
  results[id] = r.ok
  add('第三层 · 质量门禁', id, what, r.ok ? 'pass' : 'fail', r.out.slice(0, 110))
}

if (asJson) { console.log(JSON.stringify(rows, null, 2)); process.exit(0) }

console.log('')
console.log('================= 验收单（BFS-903）=================')
console.log('  判据一句话：**关掉页面，说一句话，AI 把事办成**')
console.log('')
let layer = ''
for (const r of rows) {
  if (r.layer !== layer) { layer = r.layer; console.log('\n【' + layer + '】') }
  const mark = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : r.status === 'auto' ? '🤖' : r.status === 'manual' ? '👤' : '⏭'
  console.log('  ' + mark + ' ' + r.id + '  ' + r.what)
  if (r.evidence) console.log('        ' + r.evidence)
}
const ran = rows.filter(r => r.status === 'pass' || r.status === 'fail')
const pass = ran.filter(r => r.status === 'pass').length
console.log('')
console.log('  已跑自动项：' + pass + '/' + ran.length + ' 绿' + (slow ? '' : '（慢项未跑：加 --slow）'))
console.log('  待你亲自验：L2 写图文落草稿 / L3 真发布 —— 这两条是「算不算做完」的最终依据')
console.log('======================================================')
if (ran.some(r => r.status === 'fail')) process.exit(1)
