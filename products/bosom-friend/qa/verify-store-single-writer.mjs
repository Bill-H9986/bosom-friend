#!/usr/bin/env node
/**
 * G3 门禁：数据根单写入点。
 *
 * 判据是「单写入点 + 事务语义 + 迁移器」里的第一条。`server/src/store.ts` 的
 * `atomicReplace` / `writeDataJson` / `writeDataText` 是数据根唯一的落盘实现
 * （临时文件 + fsync + rename + 目录 fsync + 写后回读），JsonFile 与所有配置文件都走它。
 *
 * 为什么必须门禁：`writeFileSync(join(dataRoot, 'x.json'), ...)` 看上去人畜无害，
 * 但断电/磁盘满时会留下**半截 JSON**——而 JSON 半截 = 整份读不出，store 的损坏守卫会
 * 拒绝该域启动，用户看到的是"数据没了"。此前 llm-user.json / settings.yaml /
 * remote-access.json / security.json / 三个模块自带的 tmp+rename 都是这么写的。
 *
 * 判定：
 *  - 第二参数是二进制（bytes / Buffer / Uint8Array）→ 图片视频产物，登记为"产物豁免"
 *    （atomicReplace 只处理文本；产物写坏一份不影响其它实体）；
 *  - 其余写数据根文本/JSON 的 writeFileSync / writeFile → **违规**，必须改走
 *    `writeDataJson` / `writeDataText` / `atomicReplace`。
 *
 * 门禁自带检测器自检：内嵌违规样本认不出来就判红。
 *
 * 用法：`node qa/verify-store-single-writer.mjs` → `STORE_SINGLE_WRITER_PASS` / `..._FAIL`
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(dirname(HERE), 'server', 'src')
const WRITE_CALL = /\b(writeFileSync|writeFile)\s*\(/g
// 【2026-10-12 补漏报】追加写：审计实测原检测器对 appendFileSync 样本返回 0（应为 1），
// 而 server/src 里真有 4 处追加写。日志类（.log/.jsonl）单列豁免，其它追加与覆盖写同罪。
const APPEND_CALL = /\b(appendFileSync|appendFile)\s*\(/g
// 【2026-10-12 补漏报】破坏性删除：rmSync/unlinkSync 不写内容，但同样能毁掉数据根里的东西
// （实测原检测器对 rmSync 样本返回 0）。单列出来供裁决，不改退出码——先让它可见。
const DELETE_CALL = /\b(rmSync|unlinkSync|rmdirSync)\s*\(/g
const BINARY_VALUE = /\b(bytes|buffer|Buffer|Uint8Array|ArrayBuffer|chunk)\b/

/**
 * 取调用点的顶层实参列表。
 *
 * @param source - 文件源码。
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
 * 一段源码里所有"数据根来源"的变量名（从 `dataRoot`/`dshHome` 出发做一层路径别名传播）。
 *
 * @param source - 文件源码。
 * @returns 变量名集合。
 */
function dataRootVariables(source) {
  const vars = new Set(['dataRoot', 'dshHome'])
  const lines = source.split('\n')
  for (let round = 0; round < 6; round++) {
    let grew = false
    for (const line of lines) {
      const m = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/)
      if (m === null || vars.has(m[1])) continue
      const rhs = m[2]
      if (!/\b(join|resolve|dirname)\s*\(/.test(rhs)) continue
      for (const v of vars) {
        if (new RegExp('(?<![\\w$.])' + v + '\\b').test(rhs)) { vars.add(m[1]); grew = true; break }
      }
    }
    if (!grew) break
  }
  // 【2026-10-12 补漏报】函数返回值也当数据根来源：`const dir = engineDir()` 这类路径
  // 此前完全识别不到（审计实测：路径来自函数返回 → violations=0，应为 1）。
  // 启发式：函数体前 400 字符里出现数据根变量，就把函数名也当来源——宁可严一点，不能漏。
  for (let round = 0; round < 2; round++) {
    const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g
    let fn
    while ((fn = fnRe.exec(source)) !== null) {
      const name = fn[1]
      if (vars.has(name)) continue
      const body = source.slice(fn.index, fn.index + 400)
      for (const v of vars) {
        if (new RegExp('(?<![\\w$.])' + v + '\\b').test(body)) { vars.add(name); break }
      }
    }
  }
  return vars
}

/**
 * 判定一段源码里"直接写数据根文本/JSON"的调用。
 *
 * @param source - 文件源码。
 * @returns 命中列表；二进制产物单列在 `products` 里。
 */
export function findDataRootWrites(source) {
  const vars = dataRootVariables(source)
  const violations = []
  const products = []
  const appends = []
  const destructive = []
  /** 目标路径是否落在数据根（字面量或经别名传播的变量）。 */
  const inRoot = (target) => {
    if (target === '') return false
    if (/\.bosom-friend/.test(target)) return true
    for (const v of vars) {
      if (new RegExp('(?<![\\w$.])' + v + '\\b').test(target)) return true
    }
    return false
  }
  const lineOf = (index) => source.slice(0, index).split('\n').length
  WRITE_CALL.lastIndex = 0
  let call
  while ((call = WRITE_CALL.exec(source)) !== null) {
    const args = topLevelArgs(source, call.index + call[0].length - 1)
    const target = (args[0] ?? '').replace(/\s+/g, ' ').trim()
    if (target === '') continue
    let inRoot = /\.bosom-friend/.test(target)
    if (!inRoot) {
      for (const v of vars) {
        if (new RegExp('(?<![\\w$.])' + v + '\\b').test(target)) { inRoot = true; break }
      }
    }
    if (!inRoot) continue
    const value = (args[1] ?? '').trim()
    const line = source.slice(0, call.index).split('\n').length
    if (BINARY_VALUE.test(value)) products.push({ api: call[1], line, target: target.slice(0, 90) })
    else violations.push({ api: call[1], line, target: target.slice(0, 90), value: value.replace(/\s+/g, ' ').slice(0, 60) })
  }

  APPEND_CALL.lastIndex = 0
  while ((call = APPEND_CALL.exec(source)) !== null) {
    const args = topLevelArgs(source, call.index + call[0].length - 1)
    const target = (args[0] ?? '').replace(/\s+/g, ' ').trim()
    if (!inRoot(target)) continue
    const line = lineOf(call.index)
    if (/\.(log|jsonl)/.test(target)) appends.push({ api: call[1], line, target: target.slice(0, 90) })
    else violations.push({ api: call[1], line, target: target.slice(0, 90), value: '(append)' })
  }

  DELETE_CALL.lastIndex = 0
  while ((call = DELETE_CALL.exec(source)) !== null) {
    const args = topLevelArgs(source, call.index + call[0].length - 1)
    const target = (args[0] ?? '').replace(/\s+/g, ' ').trim()
    if (!inRoot(target)) continue
    destructive.push({ api: call[1], line: lineOf(call.index), target: target.slice(0, 90) })
  }

  return { violations, products, appends, destructive }
}

/** 检测器自检样本：1 处该判违规的文本写入 + 2 处二进制产物（含一条路径别名）。 */
const SELF_CHECK_SAMPLE = [
  "const dataRoot = config.dataRoot",
  "const file = join(dataRoot, 'llm-user.json')",
  'writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8")',
  "writeFileSync(join(dataRoot, 'cover.png'), bytes)",
  "const up = join(dataRoot, 'uploads')",
  "writeFile(join(up, name), bytes, cb)",
  // 2026-10-12 新增两类样本（日志追加豁免 / 非日志追加算违规 / 破坏性删除单列）
  "appendFileSync(join(dataRoot, 'llm-config-audit.log'), line)",
  "appendFileSync(join(dataRoot, 'sneaky.json'), 'x')",
  "rmSync(join(dataRoot, 'platform-login', 'old'), { recursive: true, force: true })",
].join('\n')

const selfCheck = findDataRootWrites(SELF_CHECK_SAMPLE)
if (selfCheck.violations.length !== 2 || selfCheck.products.length !== 2
  || selfCheck.appends.length !== 1 || selfCheck.destructive.length !== 1) {
  console.log('STORE_SINGLE_WRITER_FAIL 检测器自检失败：违规=' + selfCheck.violations.length
    + ' 产物=' + selfCheck.products.length + ' 日志追加=' + selfCheck.appends.length
    + ' 删除=' + selfCheck.destructive.length + '（应为 2/2/1/1）')
  process.exit(1)
}

if (!existsSync(SRC)) {
  console.log('STORE_SINGLE_WRITER_FAIL 找不到 ' + SRC)
  process.exit(1)
}

const violations = []
const products = []
const appends = []
const destructive = []
let scanned = 0
for (const name of readdirSync(SRC).filter(n => n.endsWith('.ts')).sort()) {
  scanned++
  const found = findDataRootWrites(readFileSync(join(SRC, name), 'utf8'))
  for (const v of found.violations) violations.push({ file: name, ...v })
  for (const p of found.products) products.push({ file: name, ...p })
  for (const a of found.appends) appends.push({ file: name, ...a })
  for (const d of found.destructive) destructive.push({ file: name, ...d })
}

console.log('=== G3 门禁：数据根单写入点 ===')
console.log('扫描模块：' + scanned + ' 个（' + SRC + '）')
console.log('唯一原子写实现：server/src/store.ts 的 atomicReplace / writeDataJson / writeDataText')
console.log('二进制产物直写（豁免，登记在案）：' + products.length + ' 处')
for (const p of products) console.log('   PRODUCT ' + p.file + ':' + p.line + ' ' + p.api + '(' + p.target + ')')
console.log('日志类追加写（豁免，登记在案）：' + appends.length + ' 处')
for (const a of appends) console.log('   APPEND ' + a.file + ':' + a.line + ' ' + a.api + '(' + a.target + ')')
console.log('破坏性删除（待裁决，不计入退出码）：' + destructive.length + ' 处')
for (const d of destructive) console.log('   DELETE ' + d.file + ':' + d.line + ' ' + d.api + '(' + d.target + ')')
console.log('未走原语的文本/JSON 写入：' + violations.length + ' 处')
for (const v of violations) console.log('  VIOLATION ' + v.file + ':' + v.line + ' ' + v.api + '(' + v.target + ') ← ' + v.value)
const pass = violations.length === 0
console.log(pass ? 'STORE_SINGLE_WRITER_PASS' : 'STORE_SINGLE_WRITER_FAIL')
process.exit(pass ? 0 : 1)
