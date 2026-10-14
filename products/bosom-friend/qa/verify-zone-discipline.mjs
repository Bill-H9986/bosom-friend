#!/usr/bin/env node
/**
 * 分区纪律门禁（2026-10-12 立）。
 *
 * 为什么需要它：实测项目 694,062 行里，「AI 管家」形态只占 1.7%，而旧形态（前端页面 + 门禁脚本）占 60.9%。
 * 光靠"提醒"挡不住——每加一个页面按钮、每写一个一次性脚本，旧形态就再厚一层，新会话就越容易被带偏。
 * 本门禁把《项目分区图》里的**棘轮**变成可判红断言：能力那边只许长，旧形态那边只许缩。
 *
 * 判据：
 *   ① 内核工具数 >= 基线（能力必须长在管家身上）
 *   ② 前端页面行数 <= 基线（旧形态不许长大）
 *   ③ qa/ 顶层脚本数 <= 基线（一能力一门禁，不是一功能一脚本）
 *   ④ 已肃清分区不得复活（acceptance/、probes-archive/）
 *   ⑤ 现行脚本不得 import 归档区（archive/、legacy-archive/、docs/过程档案/归档/）
 *
 * 用法：
 *   node qa/verify-zone-discipline.mjs              检查（退出码 0/1）
 *   node qa/verify-zone-discipline.mjs --update     重设基线（只在确认分区图后使用）
 *   node qa/verify-zone-discipline.mjs --selftest   负向对照：证明它真的会判红
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = resolve(HERE, '..')
const BASELINE = join(HERE, 'zone-baseline.json')
const args = new Set(process.argv.slice(2))
const failures = []

/** 记录一条断言。 */
function assert(ok, id, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail)
  if (!ok) failures.push(id)
}

/** 数一个目录里的文本行（跳过依赖与产物）。 */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', '__pycache__', '.venv', 'coverage'])
const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.vue'])
function countLines(dir) {
  let lines = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(cur, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(p); continue }
      if (!e.isFile() || !TEXT.has(extname(e.name).toLowerCase())) continue
      try { lines += readFileSync(p, 'utf8').split('\n').length } catch { /* 读不到就不计 */ }
    }
  }
  return lines
}

/** 数源码里 bosom_* 工具定义（去重）。 */
function countKernelTools() {
  const dir = join(PRODUCT, 'kernel', 'src')
  const names = new Set()
  const stack = [dir]
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
  return names.size
}

/** 当前各区实测值。 */
function measure() {
  let qaScripts = 0
  try { qaScripts = readdirSync(HERE, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.mjs')).length } catch { /* 目录读不到则计 0 */ }
  return {
    kernelTools: countKernelTools(),
    frontendLines: countLines(join(PRODUCT, 'project')),
    qaTopScripts: qaScripts,
  }
}

const now = measure()

if (args.has('--update')) {
  writeFileSync(BASELINE, JSON.stringify({ at: new Date().toISOString(), ...now }, null, 2), 'utf8')
  console.log('ZONE_BASELINE_UPDATED ' + JSON.stringify(now))
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.log('ZONE_NO_BASELINE 还没有基线；先跑一次 --update 记录（这不是失败）')
  process.exit(1)
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'))

console.log('== 分区纪律（棘轮）==')
console.log('   实测：' + JSON.stringify(now) + '  基线：' + JSON.stringify({ kernelTools: base.kernelTools, frontendLines: base.frontendLines, qaTopScripts: base.qaTopScripts }))

// ① 能力只许长
assert(now.kernelTools >= base.kernelTools, '内核工具数不减少',
  now.kernelTools + ' >= ' + base.kernelTools + (now.kernelTools < base.kernelTools ? '（能力被删了：管家能办的事变少了）' : ''))

// ② 旧形态只许缩
assert(now.frontendLines <= base.frontendLines, '前端页面行数不增长',
  now.frontendLines + ' <= ' + base.frontendLines + (now.frontendLines > base.frontendLines ? '（旧形态在长大：新能力应该做成工具，不是页面按钮）' : ''))

// ③ 脚本只许缩
assert(now.qaTopScripts <= base.qaTopScripts, 'qa 顶层脚本数不增长',
  now.qaTopScripts + ' <= ' + base.qaTopScripts + (now.qaTopScripts > base.qaTopScripts ? '（一能力一门禁，不是一功能一脚本）' : ''))

// ④ 已肃清分区不得复活
for (const dead of ['qa/acceptance', 'qa/probes-archive']) {
  assert(!existsSync(join(PRODUCT, dead)), '已肃清分区未复活：' + dead,
    existsSync(join(PRODUCT, dead)) ? '它又出现了——见《项目分区图》第六节' : '不存在 ✓')
}

// ⑤ 现行脚本不得引用归档区
const ARCHIVED = /(^|[\\/])(archive|legacy-archive|归档)[\\/]/
const offenders = []
for (const e of readdirSync(HERE, { withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith('.mjs')) continue
  let src = ''
  try { src = readFileSync(join(HERE, e.name), 'utf8') } catch { continue }
  for (const m of src.matchAll(/['"`]([^'"`\n]*)[\\/](archive|legacy-archive|归档)[\\/]([^'"`\n]*)/g)) {
    if (ARCHIVED.test(m[0])) offenders.push(e.name + ' → ' + m[0].slice(0, 60))
  }
}
assert(offenders.length === 0, '现行脚本不引用归档区', offenders.length === 0 ? '无引用 ✓' : offenders.slice(0, 5).join(' ; '))

if (args.has('--selftest')) {
  // 负向对照：证明断言不是恒真——把基线人为调到"已经越界"，必须判红
  const fake = { ...base, kernelTools: base.kernelTools + 1, frontendLines: 0, qaTopScripts: 0 }
  const wouldFail = !(now.kernelTools >= fake.kernelTools) && !(now.frontendLines <= fake.frontendLines) && !(now.qaTopScripts <= fake.qaTopScripts)
  console.log((wouldFail ? 'SELFTEST_OK' : 'SELFTEST_FAIL') + ' 负向对照：人为越界时三条棘轮都判红=' + wouldFail)
  if (!wouldFail) failures.push('selftest')
}

console.log('')
if (failures.length > 0) {
  console.log('ZONE_DISCIPLINE FAIL 共 ' + failures.length + ' 项：' + failures.join(' / '))
  console.log('判据见《项目分区图》：能力只许长，旧形态只许缩。')
  process.exit(1)
}
console.log('ZONE_DISCIPLINE_OK 分区纪律成立（能力 ' + now.kernelTools + ' 工具 / 前端 ' + now.frontendLines + ' 行 / qa 顶层 ' + now.qaTopScripts + ' 脚本）')
process.exit(0)
