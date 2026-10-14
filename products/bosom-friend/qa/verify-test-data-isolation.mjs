#!/usr/bin/env node
/**
 * G3 门禁：测试不写用户数据根。
 *
 * 为什么需要：qa/ 下上千个脚本里有一批直接 `writeFileSync(join(homedir(), '.bosom-friend', ...))`，
 * 跑一次就改用户真实数据（`qa/probes/data-cleanup.mjs` 清发布记录、`data-restore.mjs` 重写账号归属）。
 * 这类脚本不会报错、不会提示，用户只会发现数据"莫名其妙变了"。
 *
 * 判定口径（每条只认一种放行方式）：
 *  1. 不直接写数据根 —— 合规；
 *  2. 直接写，但走 `qa/lib/data-root.mjs` 的 `requireWritableDataRoot()`
 *     （目标非用户根时放行，是用户根时默认抛错）—— 合规；
 *  3. 直接写，且登记在 `qa/data-write-exemptions.json` —— 记录在案（维护脚本职责），
 *     豁免数量有冻结上限，**只能减不能增**。
 *
 * 门禁自带检测器自检：内嵌一段违规样本，检测器认不出就判红（防"门禁永远绿"）。
 *
 * 用法：`node qa/verify-test-data-isolation.mjs` → `DATA_WRITE_ISOLATION_PASS` / `..._FAIL`
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXEMPTIONS = join(HERE, 'data-write-exemptions.json')
const SELF = 'verify-test-data-isolation.mjs'
const DATA_ROOT_LIB = 'lib/data-root.mjs'

/** 写 API → 哪个参数是"被写入/被移动"的目标（copyFileSync 的第二参是目标）。 */
const WRITE_TARGETS = {
  writeFileSync: [0], writeFile: [0], appendFileSync: [0], appendFile: [0],
  createWriteStream: [0], truncateSync: [0], rmdirSync: [0], rmSync: [0],
  unlinkSync: [0], mkdirSync: [0], renameSync: [0, 1], copyFileSync: [1], cpSync: [1],
}

const WRITE_CALL = new RegExp('\\b(' + Object.keys(WRITE_TARGETS).join('|') + ')\\s*\\(', 'g')

/**
 * 取调用点的顶层实参列表（跟踪括号/方括号/花括号深度，忽略字符串与模板串内的逗号）。
 *
 * @param source - 整个文件源码。
 * @param openParen - 左括号下标。
 * @returns 顶层实参文本数组。
 */
function topLevelArgs(source, openParen) {
  const args = []
  let depth = 0
  let current = ''
  let quote = ''
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i]
    if (quote !== '') {
      current += ch
      if (ch === '\\' && quote !== '`') { current += source[i + 1] ?? ''; i++ }
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; if (depth > 1) current += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) { args.push(current); return args }
      current += ch
      continue
    }
    if (ch === ',' && depth === 1) { args.push(current); current = ''; continue }
    current += ch
  }
  args.push(current)
  return args
}

/**
 * 读取调用：定义行的右值出现它们，说明这个变量装的是**文件内容**而不是路径
 * （`const records = JSON.parse(readFileSync(join(dir, 'x.json')))` 里的 `records` 不是路径别名）。
 */
const READ_CALL = /readFileSync|readdirSync|existsSync|statSync|lstatSync|readFile\b|JSON\.parse|import\s*\(/

/** 路径构造调用：只有它们产出的才是"路径别名"，据此避免把内容变量当路径。 */
const PATH_CALL = /\b(?:join|resolve|dirname|normalize)\s*\(/

/**
 * 找出一段源码里所有"数据根路径别名"（从 `.bosom-friend` 字面量出发传播）。
 *
 * 只认字面量 `.bosom-friend` 作根：不拿 `homedir()`/`USERPROFILE` 当根，
 * 否则任何家目录下的路径都会被误判成产品数据根；也要求右值是路径构造，
 * 避免把"从数据根读出来的记录数组"当成路径。
 *
 * @param source - 文件源码。
 * @returns 变量名集合。
 */
function dataRootVariables(source) {
  const vars = new Set()
  const lines = source.split('\n')
  const referencesRoot = (text) => {
    for (const v of vars) if (new RegExp('(?<![\\w$.])' + v + '\\b').test(text)) return true
    return false
  }
  for (let round = 0; round < 8; round++) {
    let grew = false
    for (const line of lines) {
      const m = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/)
      if (m === null || vars.has(m[1])) continue
      const rhs = m[2]
      if (rhs.includes('.bosom-friend')) {
        if (READ_CALL.test(rhs)) continue
        vars.add(m[1]); grew = true; continue
      }
      // 从数据根"读出来"的东西（目录项名、记录内容）不是数据根路径本身，不能当别名继续传播：
      // `const productName = readdirSync(join(SOURCE_HOME, 'uploads')).find(...)` 得到的是文件名。
      if (READ_CALL.test(rhs)) continue
      if (!PATH_CALL.test(rhs) || !referencesRoot(rhs)) continue
      vars.add(m[1]); grew = true
    }
    if (!grew) break
  }
  return vars
}

/**
 * 判定一段源码是否"直接写数据根"。
 *
 * @param source - 文件源码。
 * @returns 命中列表（API + 行号 + 片段）。
 */
export function findDataRootWrites(source) {
  const vars = dataRootVariables(source)
  const hits = []
  WRITE_CALL.lastIndex = 0
  let call
  while ((call = WRITE_CALL.exec(source)) !== null) {
    const api = call[1]
    const args = topLevelArgs(source, call.index + call[0].length - 1)
    const targets = WRITE_TARGETS[api]
    for (const idx of targets) {
      const arg = args[idx]
      if (arg === undefined) continue
      const literal = /\.bosom-friend/.test(arg)
      let named = false
      for (const v of vars) {
        if (new RegExp('(?<![\\w$.])' + v + '\\b').test(arg)) { named = true; break }
      }
      if (literal || named) {
        hits.push({ api, line: source.slice(0, call.index).split('\n').length, arg: arg.replace(/\s+/g, ' ').trim().slice(0, 160) })
        break
      }
    }
  }
  return hits
}

/** 检测器自检样本：这段必须被认出 3 处写数据根，否则门禁本身失灵。 */
const SELF_CHECK_SAMPLE = [
  "const ROOT = join(homedir(), '.bosom-friend', 'bosom-friend')",
  "const recordsFile = join(ROOT, 'publish-records.json')",
  'writeFileSync(recordsFile, data)',
  'rmSync(ROOT)',
  "copyFileSync('src.png', join(ROOT, 'x.png'))",
].join('\n')

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(mjs|cjs|mts|cts|js)$/.test(e.name)) out.push(p)
  }
  return out
}

const selfHits = findDataRootWrites(SELF_CHECK_SAMPLE)
if (selfHits.length < 3) {
  console.log('DATA_WRITE_ISOLATION_FAIL 检测器自检失败：违规样本只认出 ' + selfHits.length + ' 处（应为 3）')
  process.exit(1)
}

const exemptions = existsSync(EXEMPTIONS)
  ? JSON.parse(readFileSync(EXEMPTIONS, 'utf8'))
  : { exemptions: [], frozenCount: 0, userRootWriters: [] }
const exemptFiles = new Map((exemptions.exemptions ?? []).map(e => [e.file, e]))
const declaredWriters = new Set((exemptions.userRootWriters ?? []).map(e => e.file))

const violations = []
const guarded = []
const userRootWriters = []
let exemptHits = 0
const staleExemptions = []

for (const file of walk(HERE)) {
  const rel = relative(HERE, file).replaceAll('\\', '/')
  if (rel === SELF || rel === DATA_ROOT_LIB) continue
  const source = readFileSync(file, 'utf8')
  const usesGuard = source.includes('requireWritableDataRoot(')
  if (usesGuard) guarded.push(rel)
  // 显式要求写用户真实数据根：必须登记，否则等于用守卫的壳绕过门禁。
  if (/allowUserRoot\s*:\s*true/.test(source)) {
    if (declaredWriters.has(rel)) userRootWriters.push(rel)
    else violations.push({ file: rel, hits: [{ api: 'requireWritableDataRoot', line: 0, arg: 'allowUserRoot: true 未在 data-write-exemptions.json 的 userRootWriters 登记' }] })
  }
  const hits = findDataRootWrites(source)
  if (hits.length === 0) continue
  if (exemptFiles.has(rel)) { exemptHits++; continue }
  violations.push({ file: rel, hits })
}

for (const [file] of exemptFiles) {
  if (!existsSync(join(HERE, file))) staleExemptions.push(file + '（文件已不存在）')
}
for (const file of declaredWriters) {
  const abs = join(HERE, file)
  if (!existsSync(abs)) staleExemptions.push(file + '（userRootWriters 登记的文件已不存在）')
  else if (!/allowUserRoot\s*:\s*true/.test(readFileSync(abs, 'utf8'))) staleExemptions.push(file + '（已不再显式写用户根，可从 userRootWriters 移除）')
}

const overFrozen = exemptHits > exemptions.frozenCount
const pass = violations.length === 0 && !overFrozen

console.log('=== G3 门禁：测试不写用户数据根 ===')
console.log('扫描脚本：' + walk(HERE).length + ' 个（' + HERE + '）')
console.log('走写前守卫（requireWritableDataRoot）：' + guarded.length + ' 个')
console.log('显式写用户真实数据根（allowUserRoot，已登记）：' + userRootWriters.length + ' 个' + (userRootWriters.length > 0 ? ' → ' + userRootWriters.join(', ') : ''))
console.log('登记豁免（维护脚本）：' + exemptHits + ' 个（冻结上限 ' + exemptions.frozenCount + '）')
console.log('未登记的违规：' + violations.length + ' 个')
for (const v of violations) {
  console.log('  VIOLATION ' + v.file)
  for (const h of v.hits.slice(0, 4)) console.log('    L' + h.line + ' ' + h.api + '(' + h.arg + ')')
}
if (staleExemptions.length > 0) for (const s of staleExemptions) console.log('  WARN 过期豁免：' + s)
if (overFrozen) console.log('  VIOLATION 豁免数量 ' + exemptHits + ' 超过冻结上限 ' + exemptions.frozenCount + '：新增豁免须走评审，不能靠登记绕过')
console.log(pass ? 'DATA_WRITE_ISOLATION_PASS' : 'DATA_WRITE_ISOLATION_FAIL')
process.exit(pass ? 0 : 1)
