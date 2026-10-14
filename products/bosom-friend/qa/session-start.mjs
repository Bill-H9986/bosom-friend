#!/usr/bin/env node
/**
 * 会话启动取证脚本：一条命令输出「规则入口 + 最新进度 + 未闭环缺陷 + 运行状态」。
 *
 * 目的：新会话不必翻 80+ 份文档就能拿到当前事实（产品 AGENTS.md 第 0 节强制项）。
 * 只读：不写任何产品数据、不碰后端接口（S 级监考规则：脚本不得直接调后端或改数据文件）。
 *
 * 用法：node products\bosom-friend\qa\session-start.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const product = resolve(here, '..')
const repo = resolve(here, '..', '..', '..')
const dataRoot = process.env.BOSOM_FRIEND_HOME ?? join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend')

const rel = p => p.replace(repo + '\\', '').replace(/\\/g, '/')
const read = p => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const line = (s = '') => process.stdout.write(s + '\n')

line('==========================================================')
line(' Bosom Friend 会话启动摘要   ' + new Date().toLocaleString('zh-CN'))
line('==========================================================')

// [0] Marvis 对标进度（BFS-901）——每次会话第一眼：我在哪个阶段、该做什么、离目标差多远。
// 为什么放在最前面：跑偏的结构性原因之一是"注入的信息过载、没有优先级"，
// 于是最近看到的、最显眼的事就会被拿去做（2026-10-12 复盘总结）。方向必须先钉在最上面。
line('')
line('[0] Marvis 对标进度（BFS-901 · 施工顺序的唯一依据）')
try {
  const out = execFileSync(process.execPath, [join(product, 'qa', 'verify-marvis-progress.mjs'), '--brief'], { encoding: 'utf8', timeout: 90000 })
  for (const l of out.trim().split(/\r?\n/)) line('    ' + l)
} catch (e) {
  line('    ⚠ 进度门禁跑不起来：' + String(e && e.message ? e.message : e).slice(0, 80))
}

// [1] 规则入口
line('')
line('[1] 规则入口（缺任何一个都要先补）')
// 2026-10-12 修：原清单第一项是 docs/规范/项目铁律.md——该件已按 BFS-100 v2.0 废止并归档到
// docs/过程档案/归档/，于是每次自检都报 [MISS]（假红）；第三项的功能清单同样已被《能力台账》取代。
// 清单只登记**现行**的唯一事实源。
for (const f of [
  'docs/规范/管家化标准体系-v2.0.md',
  'docs/README.md',
  'docs/能力台账-v1.0.md',
  'qa/defects/缺陷台账.md',
  'docs/过程档案/工作日志',
]) {
  const p = join(product, f)
  const ok = existsSync(p)
  const size = ok && statSync(p).isFile() ? ' (' + Math.round(statSync(p).size / 1024) + 'KB)' : ''
  line('    ' + (ok ? '[ok]  ' : '[MISS]') + ' ' + f + size)
}

// [2] 最新工作日志
line('')
const logDir = join(product, 'docs', '过程档案', '工作日志')
let latestLog = ''
try {
  latestLog = readdirSync(logDir).filter(n => n.endsWith('.md')).sort().pop() ?? ''
} catch { /* 目录缺失时按未找到处理 */ }
line('[2] 最新工作日志：' + (latestLog || '(未找到)'))
if (latestLog) {
  const text = read(join(logDir, latestLog))
  // 同一天的日志里可能有多处「未解决/仍未闭环」小节：取**最后一个**——最新的那段才是当前待办。
  // 标题形式也放宽：既认 ### 标题，也认 **仍未闭环**：加粗行。
  const all = [...text.matchAll(/^(?:#{2,4}\s*|\*\*)[^\n]*(未解决|未闭环|下一步|待办)[^\n]*\n([\s\S]*?)(?=\n#{2,4}\s|\n\*\*[^\n]{0,24}\*\*|$)/gm)]
  const m = all[all.length - 1]
  if (m) {
    line('    当前未解决：')
    for (const l of m[2].split('\n').map(s => s.trim()).filter(Boolean).slice(0, 12)) line('      ' + l)
  } else {
    line('    （该日志没有「未解决/下一步」小节，请人工过一遍）')
  }
}

// [3] 缺陷台账：未闭环
line('')
const ledger = read(join(product, 'qa', 'defects', '缺陷台账.md'))
// 台账数据行内嵌修订流水，且部分行含未转义裸竖线（DEF-162 记录过的结构问题），
// 因此**不能按位置取列**：先锚定第一个 P0~P3 单元格，状态取其右侧一格。
// 旧实现要求整行恰好 4 个竖线，5 条长行（含 DEF-242）被静默漏报（2026-10-10 审计 R1）。
const open = []
const closedIds = new Set()
let ledgerRows = 0
let ledgerMalformed = 0
let closedRows = 0
for (const raw of ledger.split('\n')) {
  const idMatch = raw.match(/^\|\s*(DEF-\d+)\s*\|/)
  if (!idMatch) continue
  ledgerRows += 1
  const id = idMatch[1]
  const cells = raw.split('|').map(s => s.trim())
  let sevIndex = -1
  for (let i = 2; i < cells.length; i += 1) {
    if (/^P[0-3]\b/.test(cells[i])) { sevIndex = i; break }
  }
  if (sevIndex < 0) { ledgerMalformed += 1; continue }
  const severity = cells[sevIndex]
  // 状态单元格有两种写法：Fixed ｜ Fixed（已验证：…）｜ **Closed（2026-10-11 复核失效）**。
  // 只剥 `**` 会把「带处置说明的关闭态」整批算成未闭环：2026-10-12 实测报 40 条，其中 31 条其实已关闭。
  const status = (cells[sevIndex + 1] ?? '').replace(/\*\*/g, '').replace(/[（(].*$/, '').trim()
  const title = (cells[2] ?? '').replace(/\*\*/g, '').trim()
  if (/^(Fixed|Verified|Closed)$/i.test(status)) { closedRows += 1; closedIds.add(id); continue }
  open.push(id + ' | ' + severity + ' | ' + (status || '(空)') + ' | ' + title.slice(0, 60))
}
line('[3] 缺陷台账未闭环：' + open.length + ' 条（关闭态 ' + closedRows + ' 条 / 数据行 ' + ledgerRows + (ledgerMalformed > 0 ? '，其中 ' + ledgerMalformed + ' 行无法解析' : '') + '）')
for (const r of open.slice(0, 12)) line('      ' + r)

// [4] 最新交接
line('')
const analysisDir = join(repo, 'analysis')
let handoffs = []
try {
  handoffs = readdirSync(analysisDir)
    .filter(n => n.endsWith('.md'))
    .map(n => ({ n, t: statSync(join(analysisDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
} catch { /* 没有 analysis 目录时跳过 */ }
line('[4] 最新交接文档：' + (handoffs[0]?.n ?? '(无)'))
if (handoffs[0]) {
  const head = read(join(analysisDir, handoffs[0].n)).split('\n').slice(0, 14)
  for (const l of head) line('      ' + l.slice(0, 110))
}

// [5] 运行状态
line('')
line('[5] 运行状态')
line('    数据根：' + dataRoot + (existsSync(dataRoot) ? '' : '  (不存在)'))
line('    端口 31280：' + (await probe(31280) ? '监听中（开发版在跑）' : '未监听（需要 dev-web.ps1 启动）'))
const recFile = join(dataRoot, 'publish-records.json')
if (existsSync(recFile)) {
  try {
    const recs = JSON.parse(read(recFile)).value ?? []
    line('    发布记录（最近 3 条）：')
    for (const r of recs.slice(0, 3)) {
      const st = { '-1': '失败', 0: '待发布', 2: '发布中', 3: '已发布' }[String(r.status)] ?? String(r.status)
      line('      ' + r.id + '  ' + st + '  ' + String(r.title ?? '').slice(0, 28) + (r.errorMsg ? '  错误: ' + String(r.errorMsg).split('\n')[0].slice(0, 70) : ''))
    }
  } catch { line('    发布记录：解析失败') }
}

// [6] 最近改动的源码
line('')
line('[6] 最近 24h 改动的产品源码')
const srcDirs = ['server/src', 'kernel/src', 'engine', 'launcher/scripts', 'project/bosom-friend-web/src']
const recent = []
for (const d of srcDirs) {
  const root = join(product, d)
  if (!existsSync(root)) continue
  walk(root, p => {
    if (/node_modules|\\dist\\|__pycache__|social-auto-upload/.test(p)) return
    if (!/\.(ts|tsx|mjs|py|ps1)$/.test(p)) return
    const t = statSync(p).mtimeMs
    if (Date.now() - t < 24 * 3600 * 1000) recent.push({ p, t })
  })
}
recent.sort((a, b) => b.t - a.t)
for (const r of recent.slice(0, 8)) line('      ' + new Date(r.t).toLocaleString('zh-CN') + '  ' + rel(r.p))

line('')
// 2026-10-12 修：《项目铁律》与《S 级前端监考 v4》均已废止（BFS-100 v2.0 附录 B 逐条裁决），
// 提示词却一直按废止编号（铁律 #13/#17/#19）与新会话说话。编号改指现行 BFS 条款。
line('[7] 红线提醒（BFS-100 v2.0 口径）：')
line('    业务动作与验收只走 APP 前端页面；接口返回、日志、JSON 都不能单独作为 PASS（BFS-104-R）；')
line('    没有端到端证据不许说「完成」（BFS-104）；')
line('    完成一个节点当场写工作日志 + 缺陷台账 + 知识库（BFS-303）；')
line('    交付前必须自证：跑能跑的、反向对照、试边界、说清没证的，再来汇报（BFS-206）。')
line('')
line('')
line('[8] 记忆对账（2026-10-10 起，每次开工必做）')
const memoryFile = 'C:\\Users\\Jay\\Documents\\Obsidian Vault\\00-工作记忆（随时更新·新会话必读）.md'
const globalAgents = join(process.env.USERPROFILE ?? '', '.dsh', 'AGENTS.md')
const mem = read(memoryFile)
if (mem === '') {
  line('    ⚠ 活记忆读不到：' + memoryFile)
} else {
  const m = /\|\s*\*\*正在做\*\*\s*\|([^|]*)\|/.exec(mem)
  const doing = m === null ? '' : m[1].trim()
  const synced = doing !== '' && read(globalAgents).includes('- **正在做**：' + doing)
  line('    活记忆：' + (synced ? '✅ 已同步进全局注入层（新会话自动读到）' : '⚠ 未同步 → 跑 node products\\bosom-friend\\qa\\memory-sync.mjs'))
  line('      当前在做：' + (doing === '' ? '(读不到)' : doing.slice(0, 70)))
  // 2026-10-12 修：这里原来只报活记忆「三、未闭环」表的行数，与台账未闭环数不同源。
  // 两者**口径本来就不同**（产品级待办 vs 缺陷行），要求等值是新的假判据；
  // 真正该防的是「活记忆表里挂着已经关单的缺陷」——当天它就挂着已 Closed 的 DEF-251。
  const memoryOpenRows = (mem.match(/^\|\s*\d+\s*\|/gm) ?? []).length
  const staleDefs = [...new Set([...mem.matchAll(/DEF-\d+/g)].map(x => x[0]))].filter(id => closedIds.has(id))
  line('      活记忆「三、未闭环」表：' + memoryOpenRows + ' 条（产品级待办）｜ 台账未闭环：' + open.length + ' 条（缺陷行）'
    + (staleDefs.length > 0 ? '  ⚠ 活记忆表引用了已关闭缺陷：' + staleDefs.join(' ') + ' → 划掉并写证据' : ''))
}
line('    需求台账（产品负责人全部要求 / 未闭环对照）：products\\bosom-friend\\docs\\规范\\需求台账-产品负责人指令.md')
line('')

function walk(dir, fn) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, fn)
    else fn(p)
  }
}

function probe(port) {
  return new Promise(resolve => {
    const sock = connect({ port, host: '127.0.0.1' })
    const done = ok => { sock.destroy(); resolve(ok) }
    sock.setTimeout(900)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}
