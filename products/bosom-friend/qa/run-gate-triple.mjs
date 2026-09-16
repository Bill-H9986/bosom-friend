#!/usr/bin/env node
/**
 * 发布准出判定器：门禁必须连续 N 次全绿且零黄灯，才判定「可发布」。
 *
 * 单次绿灯不能作为发布依据：历史故障里同一条门禁脚本 25 分钟后重跑由红转绿（间歇性断言），
 * 一次绿灯可能是运气。所以准出规则是「连续 N 次」，N 固定为 3。
 *
 * 用法：
 *   node products/bosom-friend/qa/run-gate-triple.mjs           快速门禁 x3
 *   node products/bosom-friend/qa/run-gate-triple.mjs --full    含 S 级前端验收（应用须处于运行态）
 *   node products/bosom-friend/qa/run-gate-triple.mjs --runs 5  改轮次；发布规则固定 3 轮
 *
 * 退出码：0 = 连续 N 次全绿且零黄灯；1 = 未达标（禁止发布）
 * 留痕：qa/reports/gate-history.jsonl 每轮一行；qa/reports/gate-triple-<时间戳>.md 汇总
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const qaDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(qaDir, '..', '..', '..')
const gate = join(qaDir, 'run-gate.mjs')

const argv = process.argv.slice(2)
const full = argv.includes('--full')
const runsIndex = argv.indexOf('--runs')
const runs = runsIndex >= 0 ? Number(argv[runsIndex + 1]) : 3
if (!Number.isInteger(runs) || runs < 1) {
  console.error('RELEASE_GATE 参数错误：--runs 需要正整数。')
  process.exit(1)
}
if (!existsSync(gate)) {
  console.error('RELEASE_GATE FAIL 缺少 ' + gate)
  process.exit(1)
}

function git(args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

/** 从 run-gate 的控制台报告里取回每条检查的红黄绿，用于跨轮次聚合失败项。 */
function parseChecks(text) {
  const found = { red: [], yellow: [], green: [] }
  for (const raw of text.split(CR).join('').split(LF)) {
    const m = /^### \[(红|黄|绿)\] (.+)$/.exec(raw.trim())
    if (!m) continue
    if (m[1] === '红') found.red.push(m[2])
    else if (m[1] === '黄') found.yellow.push(m[2])
    else found.green.push(m[2])
  }
  return found
}

const reportsDir = join(qaDir, 'reports')
mkdirSync(reportsDir, { recursive: true })
const historyPath = join(reportsDir, 'gate-history.jsonl')
const gitHead = git(['rev-parse', 'HEAD'])
const dirty = git(['status', '--porcelain']) !== ''
const rounds = []

for (let i = 1; i <= runs; i++) {
  console.log('RELEASE_GATE 第 ' + i + '/' + runs + ' 轮（' + (full ? '--full' : '快速门禁') + '）')
  const res = spawnSync(process.execPath, full ? [gate, '--full'] : [gate], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const checks = parseChecks((res.stdout || '') + (res.stderr || ''))
  const round = {
    at: new Date().toISOString(),
    index: i,
    mode: full ? 'full' : 'quick',
    exitCode: res.status,
    green: checks.green.length,
    red: checks.red.length,
    yellow: checks.yellow.length,
    redNames: checks.red,
    yellowNames: checks.yellow,
    gitHead,
    dirty,
  }
  rounds.push(round)
  appendFileSync(historyPath, JSON.stringify(round) + LF, 'utf8')
  console.log('  绿=' + round.green + ' 红=' + round.red + ' 黄=' + round.yellow + ' 退出码=' + round.exitCode)
}

// 空报告（脚本崩溃/未产出检查项）不能算绿
const empty = rounds.filter((r) => r.green + r.red + r.yellow === 0)
// 未请求的检查项（快速模式不含 S 级前端验收）不计入黄灯，但结论必须写明它不能作为发布判定
const notRequested = full ? [] : ['S 级前端验收']
const blocking = rounds.filter(
  (r) => r.exitCode !== 0 || r.red > 0 || r.yellowNames.some((name) => !notRequested.includes(name)),
)
const redNames = [...new Set(rounds.flatMap((r) => r.redNames))]
const yellowNames = [...new Set(rounds.flatMap((r) => r.yellowNames))]
const releaseGrade = blocking.length === 0 && empty.length === 0

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const lines = [
  '# 发布准出判定（连续 ' + runs + ' 次门禁）',
  '',
  '- 时间：' + new Date().toISOString(),
  '- 模式：' + (full ? '--full' : '快速门禁（未含 S 级前端验收）'),
  '- Git 提交：' + gitHead + (dirty ? '（工作区有未提交改动，本结论只对这份工作区有效）' : ''),
  '- 结论：' + (releaseGrade ? (full ? '可发布（连续 ' + runs + ' 次全绿且零黄灯）' : '快速模式连续 ' + runs + ' 次全绿；未含 S 级前端验收，不能作为发布判定，发布请用 --full') : '禁止发布（未达标）'),
  '',
  '## 每轮结果',
  '',
  '| 轮次 | 绿 | 红 | 黄 | 退出码 |',
  '| --- | --- | --- | --- | --- |',
]
for (const r of rounds) lines.push('| ' + r.index + ' | ' + r.green + ' | ' + r.red + ' | ' + r.yellow + ' | ' + r.exitCode + ' |')
if (redNames.length > 0) lines.push('', '## 出现过的红灯检查项', '', ...redNames.map((n) => '- ' + n))
if (yellowNames.length > 0) lines.push('', '## 出现过的黄灯检查项（准出要求零黄灯）', '', ...yellowNames.map((n) => '- ' + n))
if (empty.length > 0) lines.push('', '## 未产出检查项的空轮次（按失败计）', '', ...empty.map((r) => '- 第 ' + r.index + ' 轮'))

const report = lines.join(LF) + LF
const reportPath = join(reportsDir, 'gate-triple-' + stamp + '.md')
writeFileSync(reportPath, report, 'utf8')
writeFileSync(join(reportsDir, 'latest-triple.md'), report, 'utf8')
console.log(report)
console.log('RELEASE_GATE ' + (releaseGrade ? 'PASS' : 'FAIL') + ' 报告：' + reportPath)
process.exit(releaseGrade ? 0 : 1)