#!/usr/bin/env node
/**
 * 内核业务工具执行验收：注册的每个工具都真跑一遍，断言「注册齐全 + execute 不炸 + render 出文本」；
 * 写回类工具另加一条"盘上那条记录真的变了"——只断言不抛错会让空实现也通过。
 *
 * 为什么必须有这条：内核工具直接读共享数据店（store.files.*），写错集合名时
 * 注册阶段完全正常、只有真被模型调用才抛
 * 「Cannot read properties of undefined (reading 'load')」——静态门禁和页面冒烟都抓不到。
 * 这条把「工具能不能跑」变成可复现的确定性断言，且默认打在打包运行时里的那份 lib 上。
 *
 * ## 安全边界（2026-10-12 补入参时同时立起）
 *
 * 工具从 18 个涨到 41 个，其中 23 个会真发布 / 真删 / 真发起登录 / 真对外回复 / 真改用户数据 /
 * 真花厂商额度 / 真去平台抓数据。本脚本跑在临时 DSH_HOME 下，但**这些工具经回环 HTTP 打到的是
 * 这台机器上活着的产品服务（127.0.0.1:31280），也就是用户的真实数据与真实账号**。
 * 为了"全绿"去真跑一次发布，是本末倒置。因此按副作用分三档，逐档在输出里说明原因：
 *
 *   1. 只读 / 零副作用工具：正常执行，真跑（这是覆盖的主力）。
 *   2. 危险工具（REFUSAL_EXPECT）：用**必然被本地前置校验拒绝**的入参执行，
 *      并全程开着安全阀——期间任何对产品服务的 fetch 都会被拦截并判红。
 *      依据：这些工具的校验都写在发起服务调用之前（kernel/src/index.ts 行号见各条注释），
 *      所以执行覆盖到本地校验为止，副作用**结构性**不可能发生；
 *      一旦将来有人把校验挪到副作用之后，安全阀会拦截而不是真发布。
 *   3. 无入参、一调就动手的工具（REGISTER_ONLY）：只验注册与参数 schema，不执行。
 *
 * 名单只放行不静默：REFUSAL_EXPECT / REGISTER_ONLY 之外的任何工具一律真跑，
 * 且产品红线点名的六类工具若掉出名单，gate-lists-valid / red-line-tools-not-executed 直接判红。
 *
 * 用法：
 *   node products/bosom-friend/qa/verify-kernel-tools.mjs
 *   BF_KERNEL_LIB="%APPDATA%/Bosom Friend/kernel-runtime/runtime/kernel/index.js" node .../verify-kernel-tools.mjs
 * 退出码：0 = 全绿；1 = 存在失败。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const REPO = dirname(dirname(PRODUCT))
const LIB = process.env.BF_KERNEL_LIB ?? join(PRODUCT, 'kernel', 'lib', 'index.js')

const results = []
/** 记录一条断言结果；失败也继续跑，最后统一汇总。 */
function check(ok, id, detail) {
  results.push({ ok: !!ok, id, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' | ' + detail)
}

/** 写一个带 schemaVersion 信封的数据文件。 */
function seed(root, file, value) {
  writeFileSync(join(root, file), JSON.stringify({ schemaVersion: 1, value }, null, 2), 'utf8')
}

// ---- 工具注册面：只许走 register() 包装（源码级断言，不依赖构建产物） ----
//
// 为什么必须有源码级判据：绕过 register() 的那几行（ctx.tools.register(defineTool({...}))）
// 在「全量注册」下与合规写法**行为完全一致**——都注册、都跑得通，上面的执行验收一条都抓不到；
// 只有按角色切开工具面时才暴露成「任何角色都拿得到这几个工具」。
// 本块管「源码里没有绕过」，下面的 role-surface-* 管「切面真的生效」，一静一动缺一有洞。
const KERNEL_SRC = process.env.BF_KERNEL_SRC ?? join(PRODUCT, 'kernel', 'src', 'index.ts')

/**
 * 生成式工具名清单：从 kernel/src/generated-tools.ts 的登记表里取。
 *
 * 为什么不逐条硬编码：登记表有 120 条且会继续长，硬编码必然漂移；
 * 从生成器源头取，登记表一变名单自动跟。
 *
 * @returns 登记表里所有工具名（可能与实际注册数不等：已由手写工具覆盖的条目会被生成器跳过）。
 */
function readGeneratedToolNames() {
  const src = join(PRODUCT, 'kernel', 'src', 'generated-tools.ts')
  if (!existsSync(src)) return []
  try {
    return [...readFileSync(src, 'utf8').matchAll(/tool: '(bosom_[a-z0-9_]+)'/g)].map(m => m[1])
  } catch { return [] }
}

/**
 * 标出处于注释或字符串里的区间：判据只认代码态出现，注释里举例提到不算违规。
 *
 * @param {string} source - 源码全文。
 * @returns {Array<[number, number]>} 忽略区间（左闭右开）。
 */
function ignoredSpans(source) {
  const spans = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end < 0 ? source.length : end
      spans.push([i, stop]); i = stop; continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end < 0 ? source.length : end + 2
      spans.push([i, stop]); i = stop; continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') { j += 2; continue }
        j += 1
      }
      const stop = Math.min(j + 1, source.length)
      spans.push([i, stop]); i = stop; continue
    }
    i += 1
  }
  return spans
}

/**
 * 检查工具注册面的两条纪律。
 *
 *   ① ctx.tools.register 在代码里只许出现一次，且它就是 register() 包装自己那一行
 *      （紧跟 const register = ... 定义之后，登记的是它的 tool 参数）；
 *   ② 每一处 defineTool( 的前一个非空白标记必须是 register( —— 工具定义只能作为包装的实参。
 *
 * @param {string} source - kernel/src/index.ts 全文。
 * @returns {{directs: Array<{line: number, text: string, at: number}>, unwrapped: Array<{line: number, text: string}>, wrapped: number, wrapperLine: number, wrapperAt: number}} 违规明细与计数。
 */
function inspectToolRegistration(source) {
  const spans = ignoredSpans(source)
  const ignored = index => spans.some(([from, to]) => index >= from && index < to)
  const lineOf = index => source.slice(0, index).split('\n').length
  const lineText = index => {
    const from = source.lastIndexOf('\n', index) + 1
    const to = source.indexOf('\n', index)
    return source.slice(from, to < 0 ? source.length : to).trim()
  }
  const wrapper = /const\s+register\s*=/.exec(source)
  const wrapperAt = wrapper === null ? -1 : wrapper.index
  const directs = []
  // 只认调用式（后跟圆括号）：register() 包装自己那一行里还有一个类型位置
  // （tool as Parameters<typeof ctx.tools.register>[0]），它不是注册调用。
  for (const m of source.matchAll(/ctx\.tools\.register\s*\(/g)) {
    if (ignored(m.index)) continue
    directs.push({ line: lineOf(m.index), text: lineText(m.index), at: m.index })
  }
  const unwrapped = []
  let wrapped = 0
  for (const m of source.matchAll(/defineTool\s*\(/g)) {
    if (ignored(m.index)) continue
    let i = m.index - 1
    while (i >= 0 && /\s/.test(source[i])) i -= 1
    // 前一个标记必须是 register( **本身**，不能是它出现在别的成员访问之后
    // （ctx.tools.register( 的尾巴同样以 register( 结尾——负向对照第一次就是这么漏过去的）。
    const before = source.slice(Math.max(0, i - 8), i + 1)
    const ownsIt = before === 'register(' && (i - 9 < 0 || source[i - 9] !== '.')
    if (ownsIt) { wrapped += 1; continue }
    unwrapped.push({ line: lineOf(m.index), text: lineText(m.index) })
  }
  return { directs, unwrapped, wrapped, wrapperLine: wrapperAt < 0 ? -1 : lineOf(wrapperAt), wrapperAt }
}

/** 读源码；读不到返回 undefined 让断言判红，不静默跳过。 */
function readSource(path) {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

/**
 * 取某个位置之后的第一个花括号块范围（跳过注释与字符串里的花括号）。
 *
 * 判据用「在包装函数体内」而不是「行距不超过 N 行」：行距会随着函数体里加一行注释就误判，
 * 而"在里面"是这条纪律真正要说的意思。
 *
 * @param {string} source - 源码全文。
 * @param {number} from - 起始位置。
 * @returns {{from: number, to: number}|undefined} 块范围（左闭右开）；找不到返回 undefined。
 */
function braceBlock(source, from) {
  if (from < 0) return undefined
  const spans = ignoredSpans(source)
  const start = source.indexOf('{', from)
  if (start < 0) return undefined
  let spanIndex = 0
  while (spanIndex < spans.length && spans[spanIndex][1] <= start) spanIndex += 1
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    while (spanIndex < spans.length && spans[spanIndex][1] <= i) spanIndex += 1
    if (spanIndex < spans.length && spans[spanIndex][0] <= i && i < spans[spanIndex][1]) {
      i = spans[spanIndex][1] - 1
      continue
    }
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { from: start, to: i }
    }
  }
  return undefined
}

const kernelSource = readSource(KERNEL_SRC)
if (kernelSource === undefined) {
  check(false, 'kernel-src-readable', '读不到内核源码：' + KERNEL_SRC)
} else {
  const surface = inspectToolRegistration(kernelSource)
  const body = braceBlock(kernelSource, surface.wrapperAt)
  const entry = surface.directs[0]
  const onlyEntry = surface.directs.length === 1
    && body !== undefined
    && entry !== undefined
    && entry.at > body.from
    && entry.at < body.to
    && /^ctx\.tools\.register\s*\(\s*tool\b/.test(kernelSource.slice(entry.at, entry.at + 60))
  check(onlyEntry, 'no-direct-ctx-tools-register',
    'ctx.tools.register 只在 register() 包装内出现 ' + String(surface.directs.length) + ' 处'
    + '（第 ' + surface.directs.map(item => item.line).join('/') + ' 行；包装定义在第 ' + String(surface.wrapperLine) + ' 行）'
    + (onlyEntry ? '' : '；绕过统一入口注册的工具会对任何角色可见，与 presets/roles.json 的归属不一致'))
  check(surface.unwrapped.length === 0, 'every-tool-through-register',
    'defineTool 共 ' + String(surface.wrapped + surface.unwrapped.length) + ' 处，经 register() 挂载 ' + String(surface.wrapped) + ' 处'
    + (surface.unwrapped.length > 0 ? '；绕过：' + surface.unwrapped.map(item => '第 ' + item.line + ' 行 ' + item.text.slice(0, 60)).join('、') : ''))
}

// ---- 能力登记表对账：源码里的写路由必须与 server/src/capabilities.ts 的登记条数逐一对应 ----
//
// 为什么必须有：覆盖率的分母就是登记表条数。分母今天漂过一次（121 → 119 → 120：task-5 新增的
// POST agent/tasks/:taskId/dispatch 一开始没登记），分母漂了，报出来的覆盖率就是假的。
// 判据与 capabilities.ts 的登记口径完全相同：`m: 'POST' | 'PUT' | 'PATCH' | 'DELETE'` 字面量。
const SERVER_SRC = join(PRODUCT, 'server', 'src')
const CAPABILITIES_SRC = join(SERVER_SRC, 'capabilities.ts')

/**
 * 扫描 server/src 全部路由表，取出写语义路由（method + path）。
 * 与 capabilities.ts 的解析口径一致：单行 `m: 'POST', p: 'x'` 与 m/p 分两行的写法都认。
 * @returns {{ routes: Array<{ method: string, path: string, file: string, line: number }>, literals: number, unresolved: string[] }}
 */
function scanWriteRoutes() {
  const routes = []
  const unresolved = []
  let literals = 0
  const files = readdirSync(SERVER_SRC).filter(name => name.endsWith('.ts')).sort()
  for (const file of files) {
    const lines = readFileSync(join(SERVER_SRC, file), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const methodHits = lines[i].match(/m:\s*'(POST|PUT|PATCH|DELETE)'/g)
      if (methodHits !== null) literals += methodHits.length
      const sameLine = /m:\s*'(POST|PUT|PATCH|DELETE)'\s*,\s*p:\s*'([^']*)'/.exec(lines[i])
      if (sameLine !== null) {
        routes.push({ method: sameLine[1], path: sameLine[2], file, line: i + 1 })
        continue
      }
      const methodOnly = /^\s*m:\s*'(POST|PUT|PATCH|DELETE)',?\s*$/.exec(lines[i])
      if (methodOnly === null) continue
      let routePath
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
        const p = /^\s*p:\s*'([^']*)',?\s*$/.exec(lines[j])
        if (p !== null) { routePath = p[1]; break }
        if (/^\s*m:/.test(lines[j])) break
      }
      if (routePath === undefined) unresolved.push(file + ':' + String(i + 1))
      else routes.push({ method: methodOnly[1], path: routePath, file, line: i + 1 })
    }
  }
  return { routes, literals, unresolved }
}

/**
 * 解析能力登记表里的条目（一条登记项 = 一行 route + source）。
 * @param {string} source - capabilities.ts 源码文本。
 * @returns {Array<{ route: string, source: string }>} 登记项（含只读与固定拒绝语义的条目）。
 */
function readRegisteredCapabilities(source) {
  const entries = []
  for (const line of source.split('\n')) {
    const hit = /route:\s*'((?:POST|PUT|PATCH|DELETE)\s+[^']*)',\s*source:\s*'([^']+)'/.exec(line)
    if (hit !== null) entries.push({ route: hit[1], source: hit[2] })
  }
  return entries
}

/**
 * 解析能力登记表里的 kind（权威读写分类）与 note（真实行为说明）。
 *
 * 为什么要它（2026-10-12 通宵 E1）：只读与写**不能靠 URL 方法猜**——登记表里 120 条全是
 * POST/PUT/PATCH/DELETE，**没有一条 GET**，而「搜索 / 列表 / 详情」用的就是 POST。
 * kind 是 capability-registry 逐条核过真实行为后写下的分类（read / write / reject），以它为准。
 *
 * @param {string} source - capabilities.ts 源码文本。
 * @returns {Array<{ tool: string, kind: string, note: string }>} 逐条分类。
 */
function readCapabilityKinds(source) {
  const rows = []
  for (const block of source.split(/\n  \{\n/).slice(1)) {
    const tool = /tool: '(bosom_[a-z0-9_]+)'/.exec(block)
    if (tool === null) continue
    const kind = /kind: '([a-z]+)'/.exec(block)
    const note = /note: '([^']*)'/.exec(block)
    rows.push({ tool: tool[1], kind: kind === null ? '' : kind[1], note: note === null ? '' : note[1] })
  }
  return rows
}

const scan = scanWriteRoutes()
const capabilitySource = readSource(CAPABILITIES_SRC)
const registeredCapabilities = capabilitySource === undefined ? [] : readRegisteredCapabilities(capabilitySource)
check(capabilitySource !== undefined, 'capability-registry-readable', '读到能力登记表：' + CAPABILITIES_SRC)
check(scan.unresolved.length === 0 && scan.literals === scan.routes.length, 'write-routes-parsed',
  'server/src 写方法字面量 ' + String(scan.literals) + ' 条，解析出 method+path ' + String(scan.routes.length) + ' 条'
  + (scan.unresolved.length ? '；解析不到 path：' + scan.unresolved.join('、') : ''))
const scannedRoutes = scan.routes.map(item => item.method + ' ' + item.path)
const registeredRoutes = registeredCapabilities.map(item => item.route)
const missingRoutes = scan.routes.filter(item => !registeredRoutes.includes(item.method + ' ' + item.path))
const staleRoutes = registeredCapabilities.filter(item => !scannedRoutes.includes(item.route))
check(scan.routes.length === registeredCapabilities.length, 'capability-registry-size-matches',
  '源码写路由 ' + String(scan.routes.length) + ' 条 vs 登记表 ' + String(registeredCapabilities.length) + ' 条（覆盖率分母必须与源码同步）')
check(missingRoutes.length === 0, 'capability-registry-no-missing-route',
  missingRoutes.length === 0
    ? '每条写路由都已登记（' + String(scan.routes.length) + ' 条）'
    : '未登记 ' + String(missingRoutes.length) + ' 条：' + missingRoutes.map(item => item.file + ':' + String(item.line) + ' ' + item.method + ' ' + item.path).join('、'))
check(staleRoutes.length === 0, 'capability-registry-no-stale-entry',
  staleRoutes.length === 0
    ? '没有「登记表里有、源码里没有」的条目'
    : '登记表多余 ' + String(staleRoutes.length) + ' 条：' + staleRoutes.map(item => item.route + '（' + item.source + '）').join('、'))

// ---- 第二层对账：登记表 → 内核投影（kernel/src/generated-tools.ts） ----
//
// 职责划分（两层都要，缺一有洞）：
//   第一层（上面那段）：server/src 源码路由 ↔ 登记表 —— 管「分母有没有漏登记 / 多登记服务端路由」；
//   第二层（本段）：登记表 ↔ 内核投影 —— 管「工具面有没有按旧名单生成」（投影过期是静默错：
//                   模型照旧工具名调用、覆盖率按旧名单算，都不报错）。
// 第一层绿而第二层红今天真实发生过：投影落后 1 条（缺 steward.dispatch），是手工补上的。
// 为什么这里不直接调 generated-tools.ts 导出的 capabilityDrift()：内核产物 lib/index.js 只导出
// apply/inject/name（esbuild 打包 + tree-shaking 把那个函数摇掉了），门禁拿不到；本段用同一套字段口径
// 做源码文本级比对，判据与它一致（逐条比 id/tool/role/kind/toolizable/exists，双向差集）。
/**
 * 解析 server/src/capabilities.ts 的登记条目（核心字段跨两行：id 行 + exists/toolizable 行）。
 * @param {string} source - 登记表源码全文。
 * @returns {Array<{id: string, tool: string, role: string, kind: string, toolizable: boolean|null, exists: boolean|null}>}
 */
function readRegistryRows(source) {
  const rows = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const head = /id: '([a-zA-Z.]+)', tool: '(bosom_[a-z0-9_]+)', role: '([a-z]+)', kind: '(write|read|reject)'/.exec(lines[i])
    if (head === null) continue
    const detail = /exists: (true|false), toolizable: (true|false)/.exec(lines[i + 1] ?? '')
    rows.push({
      id: head[1], tool: head[2], role: head[3], kind: head[4],
      exists: detail === null ? null : detail[1] === 'true',
      toolizable: detail === null ? null : detail[2] === 'true',
    })
  }
  return rows
}

/**
 * 解析内核投影（generated-tools.ts）的登记行（每条一行，字段齐全）。
 * @param {string} source - 投影源码全文。
 * @returns {Array<{id: string, tool: string, role: string, kind: string, toolizable: boolean|null, exists: boolean|null}>}
 */
function readProjectionRows(source) {
  const rows = []
  for (const line of source.split('\n')) {
    const head = /id: '([a-zA-Z.]+)', tool: '(bosom_[a-z0-9_]+)', role: '([a-z]+)'/.exec(line)
    if (head === null) continue
    const kind = /kind: '(write|read|reject)'/.exec(line)
    const exists = /exists: (true|false)/.exec(line)
    const toolizable = /toolizable: (true|false)/.exec(line)
    rows.push({
      id: head[1], tool: head[2], role: head[3], kind: kind === null ? '' : kind[1],
      exists: exists === null ? null : exists[1] === 'true',
      toolizable: toolizable === null ? null : toolizable[1] === 'true',
    })
  }
  return rows
}

/**
 * 逐条比对登记表与投影，返回差异（空数组 = 一致）。
 * @param {Array<object>} registryRows - 登记表条目。
 * @param {Array<object>} projectionRows - 投影条目。
 * @returns {string[]} 差异描述（含「投影缺少」「投影多余」两个方向）。
 */
function driftBetween(registryRows, projectionRows) {
  const drift = []
  const byId = new Map(projectionRows.map(row => [row.id, row]))
  const known = new Set()
  for (const row of registryRows) {
    known.add(row.id)
    const other = byId.get(row.id)
    if (other === undefined) { drift.push('投影缺少：' + row.id); continue }
    if (other.tool !== row.tool) drift.push(row.id + ' 工具名不一致：投影 ' + other.tool + ' / 登记表 ' + row.tool)
    if (other.role !== row.role) drift.push(row.id + ' 归属不一致：投影 ' + other.role + ' / 登记表 ' + row.role)
    if (other.kind !== row.kind) drift.push(row.id + ' 路由语义不一致：投影 ' + other.kind + ' / 登记表 ' + row.kind)
    if (other.toolizable !== row.toolizable) drift.push(row.id + ' toolizable 不一致：投影 ' + String(other.toolizable) + ' / 登记表 ' + String(row.toolizable))
    if (other.exists !== row.exists) drift.push(row.id + ' exists 不一致：投影 ' + String(other.exists) + ' / 登记表 ' + String(row.exists))
  }
  for (const row of projectionRows) if (!known.has(row.id)) drift.push('投影多余：' + row.id)
  return drift
}

const projectionSource = readSource(join(PRODUCT, 'kernel', 'src', 'generated-tools.ts'))
const registryRows = readRegistryRows(capabilitySource ?? '')
const projectionRows = readProjectionRows(projectionSource ?? '')
const registryDrift = driftBetween(registryRows, projectionRows)
check(registryRows.length > 0 && projectionRows.length > 0 && registryDrift.length === 0, 'capability-drift-registry-to-projection',
  '登记表 ' + String(registryRows.length) + ' 条 → 投影 ' + String(projectionRows.length) + ' 条，逐条比 id/tool/role/kind/toolizable/exists'
  + (registryDrift.length ? '；' + registryDrift.slice(0, 6).join('；') : ''))

// ---- 负向对照（--selftest）：证明上面两条判据不是恒真 ----
if (process.argv.includes('--selftest')) {
  const marker = "  register(defineTool({\n    name: 'bosom_platform_login_start',"
  const bypassed = kernelSource === undefined ? undefined : kernelSource.replace(marker, marker.replace('  register(', '  ctx.tools.register('))
  const applied = bypassed !== undefined && bypassed !== kernelSource
  check(applied, 'selftest-injection-applied',
    '把 bosom_platform_login_start 一处改回绕过写法：' + (applied ? '注入生效' : '注入失败（源码写法变了，对照失真）'))
  if (applied) {
    const injected = inspectToolRegistration(bypassed)
    check(injected.directs.length > 1 && injected.unwrapped.length > 0, 'selftest-detects-bypass',
      '注入后判红：ctx.tools.register ' + String(injected.directs.length) + ' 处、未包装的 defineTool ' + String(injected.unwrapped.length) + ' 处')
  }
  // 对账判据负向对照：注释掉一条登记，解析出的登记数必须变少（否则断言恒真）
  if (capabilitySource !== undefined) {
    // 删掉整条登记（只注释 id 行不会让 route 行消失，那样对照是假的）
    const dropped = capabilitySource.replace(/\n  \{\n    id: 'steward\.dispatch'[\s\S]*?\n  \},/, '')
    const afterDrop = readRegisteredCapabilities(dropped)
    check(dropped !== capabilitySource && afterDrop.length === registeredCapabilities.length - 1,
      'selftest-capability-registry-detects-drop',
      '删掉 steward.dispatch 一条登记后解析到 ' + String(afterDrop.length) + ' 条（原 ' + String(registeredCapabilities.length) + ' 条）')
  }
  // 漂移判据负向对照：删掉投影里的一条，必须报「投影缺少」（否则这条断言恒真）
  if (projectionSource !== undefined) {
    const droppedProjection = projectionSource.replace(/\n  \{ id: 'steward\.dispatch'[^\n]*/, '')
    const afterProjectionDrop = driftBetween(readRegistryRows(capabilitySource ?? ''), readProjectionRows(droppedProjection))
    check(droppedProjection !== projectionSource && afterProjectionDrop.length === 1 && afterProjectionDrop[0].includes('steward.dispatch'),
      'selftest-capability-drift-detects-drop',
      '删掉投影里 steward.dispatch 后漂移 ' + String(afterProjectionDrop.length) + ' 条：' + afterProjectionDrop.join('；'))
  }
}

if (!existsSync(LIB)) {
  console.log('FAIL kernel-lib-exists | 找不到内核构建产物：' + LIB)
  console.log('结论：请先 pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel build')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'bf-kernel-tools-'))
const dataRoot = join(home, 'bosom-friend')
mkdirSync(dataRoot, { recursive: true })

// 每个工具都要读到「非空且形状正确」的行，空数据会让投影 bug 悄悄溜过去。
seed(dataRoot, 'accounts.json', [{ id: 'acc-1', type: 'xhs', nickname: '验收账号', uid: 'u-1', status: 1, fansCount: 12, loginState: 'valid', createdAt: '2026-01-01T00:00:00.000Z' }])
seed(dataRoot, 'contents.json', [
  { _id: 'mat-1', kind: 'asset', type: 'image', title: '验收素材', useCount: 3, createdAt: '2026-01-01T00:00:00.000Z' },
  { _id: 'dft-1', kind: 'draft', title: '验收草稿', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z' },
])
seed(dataRoot, 'publish-records.json', [{ id: 'rec-1', title: '验收发布', accountType: 'xhs', type: 'ImageText', status: 2, publishTime: '2026-01-02T00:00:00.000Z' }])
seed(dataRoot, 'metrics.json', [{ id: 'met-1', recordId: 'rec-1', playCount: 7, collectedAt: '2026-01-02T00:00:00.000Z' }])
seed(dataRoot, 'reception-pending.json', [{ id: 'rp-1', accountId: 'acc-1', platform: 'xhs', content: '在吗', createdAt: '2026-01-02T00:00:00.000Z' }])
seed(dataRoot, 'draft-generations.json', [{ id: 'gen-1', status: 'completed', style: 'video', createdAt: '2026-01-03T00:00:00.000Z', response: { title: '验收生成', content: '正文' } }])
seed(dataRoot, 'job-queue.json', [{ id: 'job-1', kind: 'publish', params: {}, status: 'failed', attempt: 3, maxRetries: 2, lastError: '上游超时', createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' }])
seed(dataRoot, 'llm-user.json', { model: 'stub-model', baseUrl: 'http://127.0.0.1:1/v1' })

process.env.DSH_HOME = home

/**
 * 安全阀：危险工具执行期间，任何经 fetch 打到产品服务的请求都被拦截并记账。
 *
 * 为什么要拦而不是"相信源码里校验在前面"：源码顺序会被后人改动，而这里拦住的是一条
 * 真发布/真删除。拦下后这次调用必然抛错，而危险工具那条分支要求抛出的是**指定的**本地
 * 校验错误，所以安全阀一旦触发就是 FAIL，不会变成"看起来还行"。
 */
const realFetch = globalThis.fetch
let valveArmed = false
const valveHits = []
/** 危险工具历次执行的命中累计：valveHits 每轮清空，这条留的是全程。 */
const valveAudit = []
globalThis.fetch = async (input, init) => {
  if (valveArmed) {
    const href = typeof input === 'string' ? input : String(input?.url ?? input)
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
    valveHits.push(method + ' ' + href)
    throw new Error('门禁安全阀：这次调用本应在本地校验阶段就被拒，实际却发起了服务调用（' + method + ' ' + href + '）；已拦截，未产生副作用。')
  }
  return realFetch(input, init)
}

/**
 * 每个工具的最小可执行入参。
 *
 * 危险工具（见 REFUSAL_EXPECT）这里的入参**故意是必然被本地校验拒绝**的那一组：
 * 它的作用不是"让工具跑成功"，而是"让工具跑到它自己的校验分支"，从而证明
 * 注册没问题、参数能绑定、校验分支不崩——同时不产生任何副作用。
 */
const ARGS = {
  bosom_kernel_ping: { message: 'ping' },
  bosom_platform_list_accounts: { limit: '10' },
  bosom_reception_list_pending: { limit: '10' },
  bosom_material_list: { limit: '10' },
  bosom_data_dashboard: {},
  bosom_platform_login_status: {},
  bosom_platform_sync_works: { limit: '10' },
  bosom_content_list_drafts: { limit: '10' },
  bosom_content_generate_script: { prompt: '写一句话', kind: 'image-text' },
  bosom_job_list: { limit: '10' },
  // 【2026-10-12 改】这条工具有完整的本地前置校验（空 id / title 与 desc 都空 / 超长都抛错），
  // 所以它属于「有闸」的一类：入参用**必被本地校验拒绝**的那一组，由 REFUSAL_EXPECT 现场验证。
  // 此前给的是能成功的入参，于是它落进「只验注册」，那条位置又被两条恒绿断言占着——两个问题一起解决。
  bosom_content_update_draft: { id: '', title: '', desc: '' },
  bosom_content_video_status: { taskId: '' },
  bosom_content_generation_status: {},
  bosom_publish_list_records: { limit: '10' },
  bosom_long_video_list: {},
  bosom_data_works: {},
  bosom_digital_human_list: {},
  bosom_settings_get_llm: {},
  // 只验注册不验执行的两个工具（见 REGISTER_ONLY）：ARGS 里必须有条目，否则先被 tool-args-* 判红；
  // 有条目不等于会执行 —— 它们走的是「只验注册」分支。
  bosom_learn_from_history: {},
  bosom_reception_poll_now: {},
  // 危险闸负向对照：带 id 但**不带 order**（用户明确指令），必须被本地拒绝、零出站。
  // 2026-10-13 手写且改为 GET（只读）：空 id 必被本地校验拒绝。
  bosom_content_group_info: { id: '' },
  bosom_digital_human_import_sheet: { body: JSON.stringify({"name": "验收形象", "imageUrl": "assets/demo.png", "images": ""}) },
  bosom_platform_refresh_account_analytics: { body: JSON.stringify({"id": "acc-verify", "confirm": false}) },
  bosom_knowledge_create_note: { body: JSON.stringify({"name": "验收笔记", "folder": ""}) },
  bosom_knowledge_update_note: { body: JSON.stringify({"path": "验收笔记.md", "content": ""}) },
  bosom_material_upload_asset: { body: JSON.stringify({"assetId": "asset-verify"}) },
  bosom_material_upload_public_asset: { body: JSON.stringify({"publicUploadId": "pu-verify", "assetId": "asset-verify"}) },
  bosom_material_confirm_asset: { body: JSON.stringify({"assetId": "asset-verify"}) },
  bosom_material_confirm_public_asset: { body: JSON.stringify({"publicUploadId": "pu-verify", "assetId": "asset-verify"}) },
  bosom_reception_create_rule: { body: JSON.stringify({"name": "验收规则", "accountId": "", "platforms": "", "keywords": "", "matchMode": "any", "excludeKeywords": "", "cooldownMinutes": 0, "replyMode": "template", "template": "", "enabled": true}) },
  bosom_reception_update_rule: { body: JSON.stringify({"ruleId": "rule-verify", "name": "", "accountId": "", "platforms": "", "keywords": "", "template": "", "aiModel": "", "systemPrompt": ""}) },
  bosom_reception_list_interactions: { body: JSON.stringify({"platform": "xhs", "accountId": "acc-verify", "kind": "comment", "workId": "", "workTitle": ""}) },
  bosom_reception_conversation: { body: JSON.stringify({"platform": "xhs", "accountId": "acc-verify", "kind": "dm", "sessionId": "", "peerName": "", "workId": ""}) },
  bosom_task_cleanup_running: { body: JSON.stringify({}) },
  bosom_task_clear: { body: JSON.stringify({"taskIds": ""}) },
  bosom_task_delete: { body: JSON.stringify({"taskId": "task-verify"}) },
  bosom_content_run_object_action: { body: JSON.stringify({"kind": "draft", "id": "dft-1", "action": "rewrite", "extra": ""}) },
  bosom_device_cleanup_data: { body: JSON.stringify({"scopes": "", "all": false}) },
  bosom_digital_human_delete: { body: JSON.stringify({"id": "dh-verify"}) },
  bosom_long_video_delete: { body: JSON.stringify({"taskId": "lv-verify"}) },
  bosom_long_video_clear: { body: JSON.stringify({}) },
  bosom_device_set_remote_access: { body: JSON.stringify({"enabled": false, "bindAll": false, "tunnelCommand": "", "rotateToken": false}) },
  bosom_device_start_tunnel: { body: JSON.stringify({}) },
  bosom_device_stop_tunnel: { body: JSON.stringify({}) },
  bosom_platform_register_account: { body: JSON.stringify({"type": "xhs", "uid": "", "nickname": "", "avatar": "", "loginCookie": "", "groupId": ""}) },
  bosom_platform_create_account: { body: JSON.stringify({"type": "xhs", "uid": "", "nickname": "", "avatar": "", "loginCookie": "", "groupId": ""}) },
  bosom_platform_unbind_account: { body: JSON.stringify({"id": "acc-verify"}) },
  bosom_platform_logout_account: { body: JSON.stringify({"id": "acc-verify"}) },
  bosom_platform_create_account_group: { body: JSON.stringify({"name": "验收分组", "rank": 0}) },
  bosom_platform_update_account_group: { body: JSON.stringify({"id": "grp-verify", "name": "", "rank": 0}) },
  bosom_platform_delete_account_group: { body: JSON.stringify({"ids": "grp-verify"}) },
  bosom_publish_delete_record: { body: JSON.stringify({"recordId": "rec-verify"}) },
  bosom_publish_task_now: { body: JSON.stringify({"taskId": "pub-verify", "accountId": ""}) },
  bosom_publish_abort_current: { body: JSON.stringify({"taskId": "", "accountId": ""}) },
  bosom_publish_retry_task: { body: JSON.stringify({"taskId": "pub-verify"}) },
  // 【2026-10-13】这两条已手写（kernel/src/index.ts），参数是逐个字段，不再是生成式的 body 约定。
  // 入参用**必被本地校验拒绝**的那一组：空 taskId —— 由 REFUSAL_EXPECT 现场验证拒绝行为。
  bosom_publish_reschedule: { taskId: '', publishAt: '' },
  // 2026-10-13 手写：kind 必填且只认 draft/asset，ids 必填 —— 空值必被本地校验拒绝。
  bosom_content_transfer: { kind: '', ids: '', targetGroupId: '' },
  // 2026-10-13 手写：name 超 40 字会被本地拒绝（服务端没有这条限制，是工具自己加的护栏）。
  // 入参必须是**会被拒**的那一组：空 name 不触发长度校验，会真去调服务（第一次就踩到了，安全阀拦下）。
  bosom_content_create_group: { name: '验收用超长分组名'.repeat(6), desc: '' },
  bosom_publish_delete_task: { body: JSON.stringify({"taskId": "pub-verify"}) },
  bosom_knowledge_delete_note: { body: JSON.stringify({"path": "验收笔记.md"}) },
  // 2026-10-13 手写：逐字段 id；空 id 必被本地校验拒绝。
  bosom_content_delete_group: { id: '' },
  bosom_content_delete_many: { body: JSON.stringify({"ids": "dft-1", "kind": "draft", "cascadeGenerations": false}) },
  bosom_content_delete_drafts_by_filter: { body: JSON.stringify({"title": "", "groupId": ""}) },
  // 这条已经是手写工具（kernel/src/index.ts 的 bosom_content_delete，2026-10-12），
  // 参数是逐个字段的 id，不再走生成式的 body 约定。
  bosom_content_delete: { id: '' },
  bosom_platform_complete_douyin_auth: { body: JSON.stringify({}) },
  bosom_steward_submit_feedback: { body: JSON.stringify({}) },
  bosom_reception_delete_rule: { body: JSON.stringify({"ruleId": "rule-verify"}) },
  bosom_reception_delete_reply: { body: JSON.stringify({}) },
  bosom_reception_set_config: { body: JSON.stringify({"intervalMinutes": 5, "seenWindowMinutes": 60, "cooldownMinutes": 30, "maxPendingPerRound": 10}) },

  // —— 以下入参都为"必然被本地前置校验拒绝"，绝不产生副作用 ——
  bosom_publish_content: { accountId: 'acc-not-exist', materialId: 'mat-1', title: '验收标题', body: '验收正文', topics: 'a,b' },
  bosom_publish_draft: { draftId: 'dft-1', accountId: 'acc-1', platform: 'xhs', publishAt: '2020-01-01T00:00:00.000Z' },
  bosom_content_delete_generation: { taskId: '' },
  bosom_platform_login_start: { platform: '' },
  bosom_reception_reply: { platform: 'xhs', accountId: 'acc-1', kind: 'comment', replyText: '' },
  bosom_user_update_profile: { name: '', avatar: '' },
  bosom_content_make_cover: { draftId: '', title: '' },
  bosom_content_split_fourview: { imageUrl: '' },
  bosom_material_import_video: { videoUrl: '素材.mp4' },
  bosom_digital_human_create: { name: '', avatarUrl: '' },
  bosom_content_enhance_prompt: { prompt: '' },
  bosom_content_enhance_topic: { topic: '' },
  bosom_long_video_redo_shot: { taskId: 'lv-verify', index: '0' },
  bosom_long_video_extend_script: { taskId: '' },
  bosom_long_video_stop: { taskId: '' },
  bosom_content_create_video: { topic: '' },
  bosom_content_create_short_media: { prompt: '' },
  bosom_content_create_draft: { title: '', desc: '' },
  bosom_platform_sync_now: { accountId: '' },
  // 转交会改判任务归属并真的发起一轮（花额度、可能触发后续工具）：入参取「必被本地校验拒绝」的那一组，
  // 执行覆盖到第一道校验为止，零服务调用。
  bosom_steward_dispatch: { role: '', prompt: '', taskId: '' },
  bosom_content_resume_video: { taskId: '' },
  // 只读工具，但验收环境没有活服务里的真实草稿 id：用空 id 只验本地前置校验，
  // 不用一个编造的 id 去打活服务（那只会拿到"产品服务返回异常"，验不到东西）。
  bosom_content_get_draft: { id: '' },
  // 2026-10-12 补：以下 10 条此前从未登记过 ARGS（其中 8 条的工具早就在 kernel 里，是本门禁漏登记；
  // 2 条为本次新增的知识蒸馏工具）。入参一律用「必然被本地前置校验拒绝」的那一组，配合下面的 REFUSAL_EXPECT。
  bosom_settings_set_llm: { model: '' },
  bosom_settings_set_pref: { pref: 'theme', value: 'dark' },
  bosom_task_rate: { taskId: '', rating: '5' },
  bosom_task_favorite: { taskId: '', favorite: 'true' },
  bosom_task_share: { taskId: '' },
  bosom_task_create: { prompt: '' },
  bosom_task_follow_up: { taskId: '', content: '' },
  bosom_task_abort: { taskId: '' },
  bosom_knowledge_list_experiences: { limit: '10' },
  bosom_knowledge_promote_skill: { sourceId: '' },
}

/**
 * 危险工具表：工具名 → 该入参必须命中的**本地前置校验**错误片段。
 *
 * 每条都对着 kernel/src/index.ts 的行号核过「校验在副作用之前」：
 *   bosom_publish_content            896-910 校验 → 920 才发发布流
 *   bosom_publish_draft              2136-2148 排期校验 → 2153 才读草稿、2194 才发流
 *   bosom_content_delete_generation  2518 校验 → 2521 才查询、2531 才 DELETE
 *   bosom_platform_login_start       2614 校验 → 2615 才发起登录
 *   bosom_reception_reply            2242-2244 校验 → 2251 才发回复
 *   bosom_user_update_profile        1985 校验 → 1989 才 PUT
 *   bosom_content_make_cover         1667-1668 校验 → 1676 才生成封面（花厂商额度）
 *   bosom_content_split_fourview     1605 校验 → 1607 才切图
 *   bosom_material_import_video      1737-1738 校验 → 1739 才导入（真下载视频）
 *   bosom_digital_human_create       1901-1902 校验 → 1905 才建形象
 *   bosom_content_enhance_prompt     1512-1513 校验 → 1516 才调模型（花额度）
 *   bosom_content_enhance_topic      1572-1573 校验 → 1574 才调模型（花额度）
 *   bosom_long_video_redo_shot       1804-1805 校验 → 1806 才重做某镜（真出片）
 *   bosom_long_video_extend_script   1835 校验 → 1836 才扩写（花额度）
 *   bosom_long_video_stop            1867 校验 → 1868 才停任务
 *   bosom_content_create_video       1051 校验 → 1076 才发起分段长片
 *   bosom_content_create_short_media 1155 校验 → 1168 才发起厂商调用
 *   bosom_content_create_draft       1452 校验 → 1459 才真的写用户草稿箱
 *   bosom_platform_sync_now          2571 校验 → 2573 才去平台抓数据
 *   bosom_steward_dispatch           2788 校验 → 2800 才读任务、2807 才改判、2812 才发起新一轮
 *   bosom_content_resume_video       1327 校验 → 1329 才发起续跑
 *   bosom_content_get_draft          2379 校验 → 2380 才读草稿
 */
const REFUSAL_EXPECT = {
  bosom_publish_content: '找不到账号',
  bosom_publish_draft: '已经过去或就在一分钟内',
  bosom_content_delete_generation: '必须给 taskId',
  bosom_platform_login_start: '必须给 platform',
  bosom_reception_reply: '回复正文不能为空',
  bosom_user_update_profile: '至少给一个非空值',
  bosom_content_make_cover: '必须给 draftId',
  bosom_content_split_fourview: '必须给 imageUrl',
  bosom_material_import_video: '必须以 http:// 或 https:// 开头',
  bosom_digital_human_create: '必须给 name',
  bosom_content_enhance_prompt: '先给一句要做什么',
  bosom_content_enhance_topic: '先写清楚要讲的产品与卖点',
  bosom_long_video_redo_shot: 'index 必须是',
  bosom_long_video_extend_script: '必须给 taskId',
  bosom_long_video_stop: '必须给 taskId',
  bosom_content_create_video: 'topic 不能为空',
  bosom_content_create_short_media: 'prompt 不能为空',
  bosom_content_create_draft: '至少给一个非空值',
  bosom_platform_sync_now: '必须给 accountId',
  bosom_steward_dispatch: 'role 只支持',
  bosom_content_resume_video: '必须给 taskId',
  bosom_content_get_draft: '必须给草稿 id',
  // 2026-10-12 补（与 ARGS 同批）：文案逐条从 kernel/src/index.ts 的 throw 里核对过。
  bosom_settings_set_llm: '必须给 model',
  bosom_settings_set_pref: 'pref 只支持 disclaimer',
  bosom_task_rate: '必须给 taskId',
  bosom_task_favorite: '必须给 taskId',
  bosom_task_share: '必须给 taskId',
  bosom_task_create: '必须给 prompt',
  bosom_task_follow_up: '必须给 taskId',
  bosom_task_abort: '必须给 taskId',
  bosom_knowledge_promote_skill: '必须给 sourceId',
  // 2026-10-12 对账发现：这条原先登记为只读、实际写库（分组存在时无条件改 updatedAt + save）。
  // 补了路径判据后，入参故意带 id 但**不带 order**：它必须无 order 即本地拒绝、零出站。
  bosom_content_group_info: '必须给分组 id',
  bosom_task_cleanup_running: '要用户点头才能做',
  bosom_task_clear: '要用户点头才能做',
  bosom_task_delete: '要用户点头才能做',
  bosom_content_run_object_action: '要用户点头才能做',
  bosom_device_cleanup_data: '要用户点头才能做',
  bosom_digital_human_delete: '要用户点头才能做',
  bosom_long_video_delete: '要用户点头才能做',
  bosom_long_video_clear: '要用户点头才能做',
  bosom_device_set_remote_access: '要用户点头才能做',
  bosom_device_start_tunnel: '要用户点头才能做',
  bosom_device_stop_tunnel: '要用户点头才能做',
  bosom_platform_register_account: '要用户点头才能做',
  bosom_platform_create_account: '要用户点头才能做',
  bosom_platform_unbind_account: '要用户点头才能做',
  bosom_platform_logout_account: '要用户点头才能做',
  bosom_platform_create_account_group: '要用户点头才能做',
  bosom_platform_update_account_group: '要用户点头才能做',
  bosom_platform_delete_account_group: '要用户点头才能做',
  bosom_publish_delete_record: '要用户点头才能做',
  bosom_publish_task_now: '要用户点头才能做',
  bosom_publish_abort_current: '要用户点头才能做',
  bosom_publish_retry_task: '要用户点头才能做',
  bosom_publish_delete_task: '要用户点头才能做',
  bosom_knowledge_delete_note: '要用户点头才能做',
  bosom_content_delete_group: '必须给分组 id',
  bosom_content_delete_many: '要用户点头才能做',
  bosom_content_delete_drafts_by_filter: '要用户点头才能做',
  bosom_content_delete: '要用户点头才能做',
  // 【2026-10-12】这条工具有完整的本地前置校验（空 id / title 与 desc 都空 / 超长都抛错），
  // 属于「有闸」的一类；入参用必被本地校验拒绝的那一组，由本表现场验证它的拒绝行为。
  bosom_content_update_draft: '必须给草稿 id',
  // 改期是改一次真实发布的时间：必须用户明确指令 + 本地挡住空/非法/过去的时刻。
  bosom_publish_reschedule: '必须给 taskId',
  bosom_content_transfer: 'kind 必须是 draft',
  bosom_content_create_group: '分组名最长 40 个字',
  bosom_platform_complete_douyin_auth: '要用户点头才能做',
  bosom_steward_submit_feedback: '要用户点头才能做',
  bosom_reception_delete_rule: '要用户点头才能做',
  bosom_reception_delete_reply: '要用户点头才能做',
  bosom_reception_set_config: '要用户点头才能做',
  bosom_digital_human_import_sheet: '要用户点头才能做',
  bosom_platform_refresh_account_analytics: '要用户点头才能做',
  bosom_knowledge_create_note: '要用户点头才能做',
  bosom_knowledge_update_note: '要用户点头才能做',
  bosom_material_upload_asset: '要用户点头才能做',
  bosom_material_upload_public_asset: '要用户点头才能做',
  bosom_material_confirm_asset: '要用户点头才能做',
  bosom_material_confirm_public_asset: '要用户点头才能做',
  bosom_reception_create_rule: '要用户点头才能做',
  bosom_reception_update_rule: '要用户点头才能做',
  bosom_reception_list_interactions: '要用户点头才能做',
  bosom_reception_conversation: '要用户点头才能做',
}

/**
 * 只验注册不验执行：一调就会真动手、且当前**没有**可用「必被本地校验拒绝」入参的工具。
 *
 * 2026-10-13（P1 手写边界收严）：原名单里的 `bosom_reception_poll_now` / `bosom_learn_from_history`
 * 已补闸（新增 `order` 参数 + 本地拒绝），毕业到 REFUSAL_EXPECT 现场验证「零出站拒绝」；
 * 本表暂时为空，机制保留——将来出现无入参且构造不出拒绝入参的工具，仍从这里登记。
 */
const REGISTER_ONLY = {
}

/**
 * 需要活产品服务的**只读**查询工具：这条脚本不启动服务，所以它们**允许失败**，
 * 但失败必须是**可读的业务错误**——一旦退化成「Cannot read properties of undefined」
 * 这类崩溃，说明工具读错了集合或没做边界处理，仍然判红。
 *
 * 这里只放只读查询。原本在名单里的 create_video / resume_video / create_short_media 已改走
 * REFUSAL_EXPECT（口径更严：要求命中的是指定的本地校验错，且全程零服务调用）；
 * learn_from_history 改走 REGISTER_ONLY。
 */
const NEEDS_LIVE_SERVER = new Set([
  'bosom_content_video_status',
  'bosom_content_generation_status',
  'bosom_publish_list_records',
  'bosom_long_video_list',
  'bosom_data_works',
  'bosom_digital_human_list',
  'bosom_settings_get_llm',
])

/** 产品红线点名的工具：绝不允许在这条验收里真跑（发布/删除/登录/对外沟通/改用户数据）。 */
const RED_LINE_TOOLS = [
  'bosom_publish_content',
  'bosom_publish_draft',
  'bosom_content_delete_generation',
  'bosom_platform_login_start',
  'bosom_reception_reply',
  'bosom_user_update_profile',
  'bosom_steward_dispatch',
]

/**
 * 判断一条错误是不是"说人话的业务错误"。
 *
 * 只断言"没抛错"会让空实现通过；把"没有活服务"一律判红又会让脚本变成噪声。
 * 折中口径：信息里要有可执行指引，且不得是读未定义集合那类崩溃。
 *
 * @param message - 工具抛出的错误信息。
 * @returns 是否属于可读业务错误。
 */
function isReadableBusinessError(message) {
  if (/Cannot read propert|is not a function|undefined is not/.test(message)) return false
  return /失败|连不上|不能|请先|不存在|没有|必须|先/.test(message)
}

/** 模型桩：只吐一段确定文本，让生成类工具走到落库/投影那段真实代码。 */
function stubLlm() {
  return {
    async *stream() {
      yield { type: 'text-delta', text: '# 验收标题\n这是模型桩产出的正文。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const registered = []
const ctx = { tools: { register: tool => { registered.push(tool); return () => {} } }, llm: stubLlm() }

let mod
try {
  mod = await import(pathToFileURL(LIB).href)
} catch (error) {
  console.log('FAIL kernel-lib-import | 载入 ' + LIB + ' 抛错：' + (error instanceof Error ? error.message : String(error)))
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

try {
  mod.apply(ctx)
} catch (error) {
  console.log('FAIL kernel-apply | apply() 抛错：' + (error instanceof Error ? error.message : String(error)))
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

const names = registered.map(tool => tool.name)
const missing = Object.keys(ARGS).filter(name => !names.includes(name))
check(missing.length === 0, 'kernel-tools-registered', '已注册 ' + names.length + ' 个：' + names.join(', ') + (missing.length ? '；缺 ' + missing.join(', ') : ''))

// ---- 生成式工具：整类「只验注册与 schema，不执行」（2026-10-12 安全红线） ----
//
// 为什么整类禁跑：这批工具的 execute 是**裸代理服务端写接口**（登记表 → 一次回环 HTTP），
// 没有任何本地前置校验。门禁真跑它们 = 拿真实服务端接口当试验田：
// bosom_channels_publish_tasks_taskid_publish_now 会真发布、bosom_contents_delete 会真删、
// bosom_login_* 会真登录 —— 直接撞产品硬约束 2「未经明确发布指令绝不自动发布」。
// 补 ARGS 把门禁刷绿，恰恰会让它变成这些工具的第一个真实用户；所以它们不补真实入参，
// 只给一个空的 body（够过 schema 对齐检查）。2026-10-13 起非只读的那部分改走：
// 空 body 真调一次、断言收到本地拒绝「要用户点头才能做」且零服务调用（名单自动生成）。
// 名单从生成器源头读、与注册表求交集：生成器改了名单自动跟，不做逐条硬编码。
/**
 * 只读真跑名单（2026-10-12 立）：这些生成式工具是只读查询或静态占位实现，
 * 入参已按服务端 handler 逐条核实（见 server/src/capabilities.ts 的 params），门禁对它们真跑一次：
 * 「能注册」不等于「能办成」，字段名与必填正是此前从未验证过的洞（77 条只有注册证据）。
 *
 * 不放行其余生成式工具：它们的 execute 是裸代理服务端写接口（发布 / 删除 / 登录 / 回复），
 * 真跑就是拿用户真实数据当试验田，撞硬约束 2。
 * 依赖外部服务的两条（bosom_data_search_notes 走 UAPI 搜索、bosom_settings_fetch_models 连厂商接口）
 * 2026-10-12 实测也真跑通过，但**不进常跑名单**：门禁不该因为外部服务临时不可用而变红。
 * 它们仍走「只验注册」，入参登记在 server/src/capabilities.ts 的 params 里，实测记录见本轮交接。
 *
 * 每条都必须在登记表里核到 params —— 登记表删了 params 而这里还在真跑，由
 * read-only-live-declared-in-registry 判红，不做静默漂移。
 */
const READ_ONLY_LIVE = {
  bosom_knowledge_search: { query: '验收' },
  bosom_knowledge_backlinks: { path: '验收.md' },
  bosom_knowledge_inject_preview: { query: '验收' },
  bosom_knowledge_choose_vault: {},
  bosom_data_comment_search_options: {},
  bosom_data_analyse_note: {},
  bosom_data_note_hot_words: {},
  bosom_data_comment_stat: {},
  bosom_data_note_comments: {},
  bosom_data_parse_xhs_url: { noteId: 'demo' },
  bosom_data_export_notes: {},
  // 空关键词：服务端直接回空结论，不调外部搜索。
  bosom_data_collect_notes: { keyword: '' },
  bosom_data_note_simple_info: { noteid: 'demo' },
  bosom_data_search_douyin_topic: {},
  bosom_reception_test_rule: { message: '这个多少钱？', platform: 'xhs' },
  // 【2026-10-13】登记表的 kind 从 write 更正为 read（handler 只调 matchReception 生成建议、
  // 不写日志不发送，save 调用 0 次）。只读类应当真跑；不传 llm 时走规则匹配，不调模型、零副作用。
  bosom_reception_suggest_reply: { message: '这个多少钱？', platform: 'xhs' },
}
for (const [name, payload] of Object.entries(READ_ONLY_LIVE)) {
  ARGS[name] = { body: JSON.stringify(payload) }
}
const liveWithoutParams = Object.keys(READ_ONLY_LIVE).filter(name =>
  !new RegExp("tool: '" + name + "'[\\s\\S]{0,600}?params:").test(capabilitySource ?? ''))
check(liveWithoutParams.length === 0, 'read-only-live-declared-in-registry',
  '只读真跑名单 ' + String(Object.keys(READ_ONLY_LIVE).length) + ' 条，逐条在登记表里核到 params'
  + (liveWithoutParams.length ? '；这些没有 params：' + liveWithoutParams.join(', ') : ''))

// ---- 只读覆盖账：只读类不许有「没理由的未验证」（2026-10-12 通宵 E1） ----
//
// 权威分类是 capabilities.ts 的 kind（read / write / reject）。这份账要回答一个具体问题：
// **"未验证的那部分还剩多少、每一条的理由是什么"**——目标是把它压到最小且不留无理由的洞。
//
//   · kind=read  → 只读查询，**应当真跑**。确实不能进常跑名单的，必须登记在下面并写明理由。
//   · kind=write → 有写副作用，不真跑（硬约束 2）；每条都有统一理由：无本地前置校验，
//                  真跑就是把用户真实数据/账号当试验田。**有闸的**（capabilities.ts 的 note 写明
//                  "无 order 时本地拒绝、零出站"）走 REFUSAL_EXPECT，覆盖到本地校验为止。
//   · kind=reject→ 明确不给模型的能力（登录 / 注册 / 改密码…），不进工具面，不参与验收。
//
// 判据 read-kind-coverage 是**双向**的：
//   ① kind=read 的工具必须**要么**在 READ_ONLY_LIVE、**要么**在 EXCLUDED_READ_ONLY；
//   ② READ_ONLY_LIVE 里若有 kind=write 的（例如空 id 短路的零写动作），必须在 WRITE_LIVE_WHY 里写明理由。
// 将来 capability-registry 新增一条 read 工具而没人处理，① 立即判红——覆盖账不会悄悄漂移。
const EXCLUDED_READ_ONLY = {
  bosom_data_search_notes: '走外部 UAPI 搜索：门禁不该因为外部服务临时不可用而变红（2026-10-12 实测可跑，但不进常跑名单）',
  bosom_settings_fetch_models: '连厂商接口拉模型清单：同上，外部依赖不进常跑名单',
  bosom_content_generation_status: '手写工具（kernel/src/index.ts）已有自己的 ARGS 与执行覆盖；加进只读真跑名单会覆盖它的入参',
  // 2026-10-13：由 POST 改为 GET（只读）后必须给它归宿。它有本地前置校验（空 id 立即拒绝），
  // 与上一条同类：手写工具已有自己的 ARGS 与执行覆盖。
  bosom_content_group_info: '手写工具（kernel/src/index.ts）走 GET 只读版，带本地前置校验，ARGS 走 REFUSAL_EXPECT 验拒绝行为',
}
const WRITE_LIVE_WHY = {
  // 2026-10-13：rate 已进闸（非只读 = 必须有 order），从只读真跑名单移出 → 走 REFUSAL_EXPECT。
  // 机制保留：将来若再有 kind=write 的工具进只读真跑名单，必须在这里写明「为什么真跑也不会写」。
}
const capabilityKinds = readCapabilityKinds(capabilitySource ?? '')
const readKindTools = capabilityKinds.filter(r => r.kind === 'read').map(r => r.tool)
const unhandledReads = readKindTools.filter(t => !(t in READ_ONLY_LIVE) && !(t in EXCLUDED_READ_ONLY))
check(unhandledReads.length === 0, 'read-kind-coverage',
  'kind=read 的 ' + String(readKindTools.length) + ' 条：真跑 ' + String(readKindTools.filter(t => t in READ_ONLY_LIVE).length)
  + ' 条 ＋ 明确排除 ' + String(readKindTools.filter(t => t in EXCLUDED_READ_ONLY).length) + ' 条（各带理由）'
  + (unhandledReads.length ? '；**这些只读工具没有归宿（没人真跑也没写理由）**：' + unhandledReads.join(', ') : ''))
const liveWriteTools = Object.keys(READ_ONLY_LIVE).filter(t => {
  const row = capabilityKinds.find(r => r.tool === t)
  return row !== undefined && row.kind === 'write'
})
const unexplainedLiveWrites = liveWriteTools.filter(t => !(t in WRITE_LIVE_WHY))
check(unexplainedLiveWrites.length === 0, 'write-in-live-needs-reason',
  '只读真跑名单里 kind=write 的 ' + String(liveWriteTools.length) + ' 条，逐条写明「为什么真跑也不会写」'
  + (unexplainedLiveWrites.length ? '；这些没写理由：' + unexplainedLiveWrites.join(', ') : ''))

// 覆盖账（把「未验证的还剩多少、每条的理由」一次印清楚）：目标是把未验证压到最小，
// 且**每一条都有理由**——不是靠"名单外一律真跑"这种默认，而是靠逐条分类。
{
  const kinds = { read: 0, write: 0, reject: 0, '': 0 }
  for (const row of capabilityKinds) kinds[row.kind in kinds ? row.kind : ''] += 1
  console.log('')
  console.log('== 能力覆盖账（分类来自 server/src/capabilities.ts 的 kind）==')
  console.log('   登记 ' + String(capabilityKinds.length) + ' 条：只读 ' + String(kinds.read) + ' ｜ 写 ' + String(kinds.write) + ' ｜ 固定拒绝 ' + String(kinds.reject) + (kinds[''] > 0 ? ' ｜ 未标 kind ' + String(kinds['']) : ''))
  console.log('   只读 ' + String(kinds.read) + ' 条 → 真跑 ' + String(readKindTools.filter(t => t in READ_ONLY_LIVE).length)
    + ' ｜ 明确排除 ' + String(readKindTools.filter(t => t in EXCLUDED_READ_ONLY).length) + '（各带理由：外部依赖 ×2、手写工具已覆盖 ×1）')
  // 闸门覆盖的**权威数字是实测**：REFUSAL_EXPECT 里的每一条，每次跑门禁都会用「必被本地校验拒绝」的
  // 入参真跑一次——它若没有本地前置闸，安全阀会当场拦下并判红。所以"有闸"不是靠 note 自称，
  // 而是靠这条断言每次现场验证（capabilities.ts 的 note 只写到 1 条，不足以当数字用）。
  console.log('   写 ' + String(kinds.write) + ' 条 → 一律不真跑（硬约束 2）。其中**实测有本地前置闸**（REFUSAL_EXPECT，'
    + '每轮都用"必被本地校验拒绝"的入参现场验证）' + String(Object.keys(REFUSAL_EXPECT).length) + ' 条；其余只验注册')
  console.log('   固定拒绝 ' + String(kinds.reject) + ' 条 → 不进工具面（登录 / 注册 / 改密码这类安全动作），不参与验收')
  console.log('   **未验证的部分只剩「写操作」一整类，理由统一且明确：execute 是裸代理服务端接口、无本地前置校验，真跑就是拿真实数据当试验田。**')
}

const GENERATED_ALL = readGeneratedToolNames()
const GENERATED = GENERATED_ALL.filter(name => names.includes(name))
for (const name of GENERATED) {
  if (!(name in ARGS)) ARGS[name] = { body: '' }
  // 只读真跑名单里的工具不进「只验注册」：它们的入参已在登记表逐条核过，真跑才有「能办成」的证据。
  if (name in READ_ONLY_LIVE) continue
  if (name in REFUSAL_EXPECT) continue
  const generatedKind = capabilityKinds.find(row => row.tool === name)?.kind ?? ''
  if (generatedKind === 'read') {
    // 生成式只读工具：要么在 READ_ONLY_LIVE（真跑）、要么在 EXCLUDED_READ_ONLY（写了理由）。
    // 到这里仍不在真跑名单的，只验注册（不执行）——只读覆盖账 read-kind-coverage 已先行判红。
    REGISTER_ONLY[name] = '生成式只读工具：未进真跑名单（归宿见 read-kind-coverage）'
    continue
  }
  // 非只读的生成式工具：一律现场验证「本地拒绝、零出站」（名单自动生成，不手工维护）。
  REFUSAL_EXPECT[name] = '要用户点头才能做'
}

// ---- 工具面即权限：角色面必须真的把工具切干净 ----
//
// 这是上面静态判据的**行为对照**，也是「绕过 register()」真正的后果断言：
// 本次验收默认走全量注册，绕过的那几个工具与合规工具完全一样（都在、都能跑）；
// 按角色重放 apply 时，绕过的工具会出现在**每一个**角色的面上，而 presets/roles.json 只把它给了其中一个。
// 所以逐角色比对「实际注册集合 == 该角色声明的面」，绕过行为就无处可藏。
const ROLES_JSON = join(PRODUCT, 'presets', 'roles.json')
let roles
try {
  roles = JSON.parse(readFileSync(ROLES_JSON, 'utf8'))
} catch (error) {
  check(false, 'role-surface-roles-readable', '读不到或解析不了工具面事实源 ' + ROLES_JSON + '：' + String(error?.message ?? error))
}
if (roles !== undefined && (roles === null || typeof roles !== 'object')) {
  check(false, 'role-surface-roles-readable', ROLES_JSON + ' 的顶层不是对象')
  roles = undefined
}
if (roles !== undefined) {
  for (const role of Object.keys(roles)) {
    const patterns = Array.isArray(roles[role]) ? roles[role].filter(item => typeof item === 'string') : []
    const expected = names.filter(toolName => patterns.some(pattern => pattern.endsWith('*')
      ? toolName.startsWith(pattern.slice(0, -1))
      : toolName === pattern))
    const seen = []
    const roleCtx = { tools: { register: tool => { seen.push(tool); return () => {} } }, llm: stubLlm() }
    let failure
    try {
      mod.apply(roleCtx, { tools: patterns })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure !== undefined) {
      check(false, 'role-surface-' + role, '按角色重放 apply 抛错：' + failure)
      continue
    }
    const actual = seen.map(tool => tool.name)
    const extra = actual.filter(toolName => !expected.includes(toolName))
    const lack = expected.filter(toolName => !actual.includes(toolName))
    check(extra.length === 0 && lack.length === 0 && expected.join('|') === actual.join('|'), 'role-surface-' + role,
      '声明 ' + patterns.join(' / ') + ' → 实得 ' + String(actual.length) + ' 个工具'
      + (extra.length > 0 ? '；多出 ' + extra.join('、') + '（绕过 register() 或角色面没生效：这些工具会对该管家可见）' : '')
      + (lack.length > 0 ? '；少了 ' + lack.join('、') : ''))
  }
}

// 两份名单本身也要能被断言：不允许多余名字、不允许重叠、不允许红线工具掉出保护范围。
const strayNames = [...Object.keys(REFUSAL_EXPECT), ...Object.keys(REGISTER_ONLY)].filter(name => !names.includes(name))
const overlapped = Object.keys(REFUSAL_EXPECT).filter(name => name in REGISTER_ONLY)
// 【2026-10-13 立】两份名单里出现重复 key 时，后面的静默覆盖前面的——JS 对象字面量合法，所以不会报错。
// 当天已经踩过两次（bosom_content_delete 出现两行；bosom_content_transfer 的生成式预留与手写条目并存），
// 两次都是靠「跑门禁看到实际拒绝文案不对」才发现的。这条断言把「谁覆盖了谁」变成当场可见。
// 【2026-10-13 二次修正：第一版是假断言】第一版扫的是 `Object.keys(ARGS)`——
// 而 JS 对象字面量的 key 天然唯一，重复的早被后者覆盖掉了，`Object.keys()` 永远不重复，
// 于是那条断言**永远不会红**。当天用它没能拦住 `bosom_content_transfer` 出现两行。
// 现在改成**扫源码文本**：同一缩进层里同名 key 出现两次就记下来——这才是「谁覆盖了谁」的证据。
const duplicateKeys = []
try {
  const gateSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const SECTION_RE = /^const (ARGS|REFUSAL_EXPECT|REGISTER_ONLY) = \{/m
  for (const label of ['ARGS', 'REFUSAL_EXPECT', 'REGISTER_ONLY']) {
    const start = gateSource.search(new RegExp('^const ' + label + ' = \\{', 'm'))
    if (start < 0) continue
    const tail = gateSource.slice(start)
    const end = tail.indexOf('\n}')
    const block = end < 0 ? tail : tail.slice(0, end)
    const seen = new Set()
    for (const line of block.split('\n')) {
      const hit = /^\s{2}(bosom_[a-z0-9_]+):\s/.exec(line)
      if (hit === null) continue
      if (seen.has(hit[1])) duplicateKeys.push(label + ' 里 ' + hit[1] + ' 出现两次（后者静默覆盖前者）')
      seen.add(hit[1])
    }
  }
} catch (error) {
  duplicateKeys.push('扫名单源码失败：' + String(error))   // 扫不动就当异常，不静默放过
}
check(duplicateKeys.length === 0, 'gate-lists-no-duplicate-keys',
  '三份名单无重复 key' + (duplicateKeys.length ? '；' + duplicateKeys.join('；') : ''))

check(strayNames.length === 0 && overlapped.length === 0, 'gate-lists-valid',
  '危险工具 ' + String(Object.keys(REFUSAL_EXPECT).length) + ' 个、只验注册 ' + String(Object.keys(REGISTER_ONLY).length) + ' 个'
  + (strayNames.length ? '；名单里有不存在的工具：' + strayNames.join(', ') : '')
  + (overlapped.length ? '；两份名单重叠：' + overlapped.join(', ') : ''))

const exposedRedLine = RED_LINE_TOOLS.filter(name => !(name in REFUSAL_EXPECT) && !(name in REGISTER_ONLY))
check(exposedRedLine.length === 0, 'red-line-tools-not-executed',
  '红线工具（发布/删除/登录/回复/改用户数据）' + String(RED_LINE_TOOLS.length) + ' 个全部落在"不真跑"名单里'
  + (exposedRedLine.length ? '；这些会被真跑：' + exposedRedLine.join(', ') : ''))

// 入参必须真的对得上工具的 schema：字段名写错、必填漏给，都在这里变成红。
const schemaProblems = []
for (const tool of registered) {
  const args = ARGS[tool.name]
  if (args === undefined) continue
  const properties = Object.keys(tool.parameters?.properties ?? {})
  const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : []
  for (const key of Object.keys(args)) {
    if (!properties.includes(key)) schemaProblems.push(tool.name + ' 多出 schema 里没有的字段 ' + key)
  }
  for (const key of required) {
    if (!(key in args)) schemaProblems.push(tool.name + ' 漏给必填字段 ' + key)
  }
}
check(schemaProblems.length === 0, 'args-match-tool-schema',
  'ARGS 与各工具 parameters 对齐：' + String(registered.length) + ' 个工具逐字段核过字段名与必填' + (schemaProblems.length ? '；' + schemaProblems.join('；') : ''))

for (const tool of registered) {
  const args = ARGS[tool.name]
  if (args === undefined) {
    check(false, 'tool-args-' + tool.name, '验收脚本没有为该工具准备入参')
    continue
  }
  const registerOnlyReason = REGISTER_ONLY[tool.name]
  if (registerOnlyReason !== undefined) {
    // 只验注册不验执行：工具确实注册了、入参与 schema 对齐（前面那条已逐字段核过），
    // 但**不执行**——一调就真动手，且没有可用的"必被本地校验拒绝"的入参。
    check(true, 'tool-exec-' + tool.name, '只验注册与参数 schema，不执行：' + registerOnlyReason)
    continue
  }

  const expectRefusal = REFUSAL_EXPECT[tool.name]
  let value
  let failure
  valveHits.length = 0
  valveArmed = expectRefusal !== undefined
  try {
    value = await tool.execute(args)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    valveArmed = false
  }
  if (expectRefusal !== undefined && valveHits.length > 0) valveAudit.push(...valveHits)

  if (expectRefusal !== undefined) {
    if (valveHits.length > 0) {
      check(false, 'tool-exec-' + tool.name, '本应在本地校验阶段就被拒，实际发起了服务调用（安全阀已拦截，未产生副作用）：' + valveHits.join('、'))
      continue
    }
    if (failure === undefined) {
      // 没被拒但也没发任何服务调用 → 没有副作用，按正常执行判。
      let text = ''
      try {
        text = tool.output.render(args, value).map(part => part.text ?? '').join('')
      } catch (error) {
        check(false, 'tool-render-' + tool.name, 'execute 成功但 render 抛错：' + (error instanceof Error ? error.message : String(error)))
        continue
      }
      check(text.trim() !== '', 'tool-exec-' + tool.name, '入参未被拒但全程零服务调用（无副作用），execute + render 正常，渲染 ' + text.replace(/[ \t\r\n]+/g, ' ').trim().slice(0, 70))
      continue
    }
    if (failure.includes(expectRefusal)) {
      check(true, 'tool-exec-' + tool.name, '只验到本地前置校验（零服务调用，无副作用）：' + failure.replace(/[ \t\r\n]+/g, ' ').slice(0, 80))
      continue
    }
    check(false, 'tool-exec-' + tool.name, '期望被本地校验拒绝（应含「' + expectRefusal + '」），实际：' + failure.replace(/[ \t\r\n]+/g, ' ').slice(0, 120))
    continue
  }

  if (failure !== undefined) {
    if (NEEDS_LIVE_SERVER.has(tool.name) && isReadableBusinessError(failure)) {
      check(true, 'tool-exec-' + tool.name, '无活服务时抛出可读业务错误：' + failure.replace(/[ \t\r\n]+/g, ' ').slice(0, 70))
      continue
    }
    check(false, 'tool-exec-' + tool.name, 'execute 抛错：' + failure)
    continue
  }
  let text
  try {
    const parts = tool.output.render(args, value)
    text = parts.map(part => part.text ?? '').join('')
  } catch (error) {
    check(false, 'tool-render-' + tool.name, 'execute 成功但 render 抛错：' + (error instanceof Error ? error.message : String(error)))
    continue
  }
  check(text.trim() !== '', 'tool-exec-' + tool.name, 'execute + render 正常，渲染 ' + text.replace(/[ \t\r\n]+/g, ' ').trim().slice(0, 70))
}

// 安全阀全程一次都不该响：响了说明有危险工具绕过了本地校验，或只读工具真去动了服务。
check(valveAudit.length === 0, 'safety-valve-never-tripped', '危险工具' + String(Object.keys(REFUSAL_EXPECT).length) + ' 个全程零服务调用' + (valveAudit.length ? '；被拦截：' + valveAudit.join('、') : ''))

// 数据看板是真读盘的工具：断言它读到的是种子数据，而不是「一律 0」的假绿。
const dashboard = registered.find(tool => tool.name === 'bosom_data_dashboard')
if (dashboard !== undefined) {
  const value = await dashboard.execute({})
  check(value.accounts === 1 && value.publishRecords === 1 && value.metricRows === 1,
    'dashboard-reads-real-data', '账号 ' + value.accounts + ' / 发布记录 ' + value.publishRecords + ' / 指标行 ' + value.metricRows + '（种子各 1）')
  check(value.materials === 1, 'materials-from-contents', '素材数 ' + value.materials + '（contents 里 kind=asset 的 1 条）')
}

const materials = registered.find(tool => tool.name === 'bosom_material_list')
if (materials !== undefined) {
  const value = await materials.execute({ limit: '10' })
  check(value.count === 1 && value.items[0]?.title === '验收素材', 'material-list-projects-asset', '素材 ' + value.count + ' 条，首条《' + (value.items[0]?.title ?? '') + '》')
}

// 写回工具必须真的改了盘上那条草稿：只断言"execute 不抛错"会让一个空实现也通过。
const seeded = JSON.parse(readFileSync(join(dataRoot, 'contents.json'), 'utf8'))
const seededDraft = (Array.isArray(seeded?.value) ? seeded.value : []).find(item => item?._id === 'dft-1')
// 【2026-10-12 更正：删除一条恒绿断言】
//
// 这里原本锁的是「内核**不**写回草稿（改写由前端执行）」。那句话描述的是**旧实现**，已过时：
// `bosom_content_update_draft` 现在**真的写库**（见 kernel/src/index.ts 的 execute 里那次 PUT；
// 注释记了改的原因：把「发布需授权」泛化成「所有写操作都要页面执行」，结果是用户说完话、草稿一个字没动）。
//
// 更关键的是：**它在本门禁里属于「生成式整类不执行」**，工具根本没跑——
// **不跑的工具，盘上当然不会变**，于是「盘上标题仍为《验收草稿》」**恒为真、证明不了任何事**。
// 一条恒绿断言比没有断言更危险：它会让后来者以为这里验过写回行为。
//
// 现在改为**如实声明覆盖边界**：本门禁不负责验证它的写回，那是端到端用例的事。
// 保留对种子数据的读取，是因为下一条断言（desc 不被写空）仍需要使用它。
check(seededDraft !== undefined, 'draft-seed-present',
  '种子草稿在盘上（供写回类断言使用）：《' + String(seededDraft?.title ?? '(缺)') + '》')
// 同上：下一条（「只传 title 时 desc 不被写空」）也是恒绿——工具不跑，desc 自然不会被动。
// 一并删除，不留第二条假绿。这两条共同想证明的「写回行为」归端到端用例负责：
// 见 docs/规范/验收标准-一句话端到端.md 的三方证据（工具返回 + 助手回复 + 落库/页面数据）。

rmSync(home, { recursive: true, force: true })

console.log('')
console.log('未真跑的工具（避免真发布/真删/真登录/真回复/真改数据/真花额度）：')
console.log('  · 只验到本地前置校验（零服务调用）' + String(Object.keys(REFUSAL_EXPECT).length) + ' 个：' + Object.keys(REFUSAL_EXPECT).join(', '))
const generatedSet = new Set(GENERATED)
const handRegisterOnly = Object.entries(REGISTER_ONLY).filter(([name]) => !generatedSet.has(name))
for (const [name, reason] of handRegisterOnly) {
  console.log('  · 只验注册不验执行：' + name + ' —— ' + reason)
}
const registerOnlyGenerated = Object.keys(REGISTER_ONLY).filter((name) => generatedSet.has(name))
console.log('  · 只验注册不验执行（生成式只读未进真跑名单的口子）' + String(registerOnlyGenerated.length) + ' 个：' + (registerOnlyGenerated.length > 0 ? registerOnlyGenerated.join(', ') : '（无）'))
if (GENERATED_ALL.length !== GENERATED.length) {
  console.log('  · 登记表共 ' + String(GENERATED_ALL.length) + ' 条，其中 ' + String(GENERATED_ALL.length - GENERATED.length) + ' 条已被手写工具覆盖（生成器 exists:true 跳过），未进名单')
}
const trulyRan = registered.length - Object.keys(REFUSAL_EXPECT).length - Object.keys(REGISTER_ONLY).length
console.log('')
console.log('分类计数：真跑 ' + String(trulyRan) + ' 个 ｜ 只验注册 ' + String(Object.keys(REGISTER_ONLY).length) + ' 个（生成式只读未真跑 ' + String(registerOnlyGenerated.length) + ' + 手写 ' + String(handRegisterOnly.length) + '）｜ 危险工具只验本地校验 ' + String(Object.keys(REFUSAL_EXPECT).length) + ' 个（合计 ' + String(registered.length) + ' 个注册工具）')

const failed = results.filter(item => !item.ok)
console.log('')
console.log('内核工具验收：' + (results.length - failed.length) + '/' + results.length + ' 通过' + (failed.length ? '，失败：' + failed.map(item => item.id).join(', ') : ''))
console.log('被验产物：' + LIB)
process.exit(failed.length === 0 ? 0 : 1)
