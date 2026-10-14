#!/usr/bin/env node
/**
 * 门禁：管家「工具面」的唯一事实源与它的全部表示必须逐条一致。
 *
 * ## 为什么必须有这条（2026-10-12）
 *
 * 工具面即权限边界（BFS-102）。同一个事实在产品里有四处表示，改一处忘一处就是
 * 「某个管家凭空少几个工具」——真实的漂移发生过三次：
 *   - steward 漏 bosom_task_*（列举式表示全量，内核一加工具就跟不上）；
 *   - operator 漏 bosom_platform_sync_now；
 *   - device 漏 bosom_platform_login_start。
 *
 * **唯一事实源：presets/roles.json**。理由是它才是运行期真正被读的那份
 * （kernel/src/index.ts 的 resolveAllowList 经 BF_AGENT_ROLE 读
 * $DSH_HOME/.agent-presets/roles.json）。其余三处是它的表示：
 *   1. presets/<role>/agent.cordis.yml 的 bosom-kernel.config.tools
 *      （DSH 的 agent-presets 以它为组装源；当前内核入口 dsh-sdk-jsonrpc-server
 *        不做 preset 组装，故它眼下不生效，但 DSH 一旦接入就会生效）；
 *   2. project/bosom-friend-web/src/components/team/roles.ts 的 toolSurface
 *      （前端读不到 presets/，内联镜像，界面上「这个管家能做什么」照它念）；
 *   3. server/src/types.ts 的 ZyAgentRole 联合类型（角色词表的类型表示）。
 * 另加一处运行期副本：$DSH_HOME/.agent-presets/ —— 内核读的是它，不是仓库里的源；
 * 仓库改了不同步，运行期就还是旧工具面（这正是「唯一事实源」失效的方式）。
 *
 * ## 判定
 *
 * 逐条比对（顺序敏感：顺序变了说明有人手改，而手改就是漂移的入口）。
 * 全部一致 → PASS 退出码 0；任何一条不一致 → FAIL 退出码 1，并打印逐条差异与改法。
 *
 * 共 11 项：前 10 项比对的是**文件之间**的一致；第 11 项 runtime-injection-by-owner 守的是
 * **运行期注入点**——对话入口按 task.agentRole 把角色注入内核、会话池键带上角色，并在临时
 * home 里按 BF_AGENT_ROLE 重放内核 apply，断言 creator 的面里没有发布工具，同时用 steward
 * 的面里有发布工具做对照（防"面为空"的假绿）。这一处坏掉时，前面十项**一项都不会红**。
 *
 * 用法：node products/bosom-friend/qa/verify-preset-parity.mjs
 * 退出码：0 = 一致；1 = 存在漂移。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)

const ROLES_JSON = join(PRODUCT, 'presets', 'roles.json')
const PRESET_DIR = join(PRODUCT, 'presets')
const FRONTEND_MIRROR = join(PRODUCT, 'project', 'bosom-friend-web', 'src', 'components', 'team', 'roles.ts')
const ROLE_TYPE = join(PRODUCT, 'server', 'src', 'types.ts')
/** 注入点所在源码：对话入口与会话池都在这份文件里（BF_API_SRC 只给负向对照用）。 */
const API_SRC = process.env.BF_API_SRC ?? join(PRODUCT, 'server', 'src', 'api.ts')
/** 内核构建产物：运行时断言在它上面重放 apply（口径与 qa/verify-kernel-tools.mjs 一致）。 */
const KERNEL_LIB = process.env.BF_KERNEL_LIB ?? join(PRODUCT, 'kernel', 'lib', 'index.js')
/** 官方 SDK server 源码目录（BF_SDK_SERVER_DIR 只给负向对照用）。 */
const SDK_SERVER_SRC = process.env.BF_SDK_SERVER_DIR ?? join(PRODUCT, '..', '..', 'packages', 'sdk', 'server', 'src')
/** 内核补丁层（BF_KERNEL_PATCH 只给负向对照用）。 */
const KERNEL_PATCH = process.env.BF_KERNEL_PATCH ?? join(PRODUCT, 'kernel', 'cordis.patch.yml')

const results = []
/** 记录一条断言结果；失败也继续跑，最后统一汇总。 */
const ok = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail })
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (detail === '' ? '' : '  —  ' + detail))
}

/** 读文本；读不到返回 undefined（调用方负责判红，不静默跳过）。 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 统一行尾：行尾不是语义，只比内容。 */
const norm = text => text.replace(/\r\n/g, '\n')

/**
 * 取一份 agent.cordis.yml 里 bosom-kernel 的 config.tools 列表。
 *
 * 刻意不引 YAML 解析器（不新增依赖）：这两个文件由我们自己维护，
 * 形状固定为 tools: + 缩进列表项。解析不到返回 undefined 让调用方判红，
 * 而不是回一个空数组把「文件被改坏」伪装成「工具面为空」。
 * @param {string} text - 组成文件全文。
 * @returns {string[]|undefined} 工具名或前缀（已去引号），找不到返回 undefined。
 */
function presetTools(text) {
  const lines = norm(text).split('\n')
  const start = lines.findIndex(line => /^\s*tools:\s*$/.test(line))
  if (start < 0) return undefined
  const baseIndent = lines[start].match(/^\s*/)[0].length
  const items = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const indent = line.match(/^\s*/)[0].length
    if (indent <= baseIndent) break
    const item = line.match(/^\s*-\s*(.+?)\s*$/)
    if (item === null) break
    items.push(item[1].replace(/^['"]|['"]$/g, ''))
  }
  return items
}

/**
 * 取前端镜像里的 角色代号 → 工具面模式列表。
 * @param {string} text - roles.ts 全文。
 * @returns {Array<{code: string, patterns: string[]}>} 按文件里的出现顺序。
 */
function frontendMirror(text) {
  const source = norm(text)
  const codes = [...source.matchAll(/code:\s*'([^']+)'/g)]
  return codes.map((match, index) => {
    const from = match.index + match[0].length
    const to = index + 1 < codes.length ? codes[index + 1].index : source.length
    const patterns = [...source.slice(from, to).matchAll(/pattern:\s*'([^']*)'/g)].map(item => item[1])
    return { code: match[1], patterns }
  })
}

/**
 * 取 server 侧 ZyAgentRole 联合类型的成员。
 * @param {string} text - types.ts 全文。
 * @returns {string[]|undefined} 角色代号，找不到返回 undefined。
 */
function roleTypeMembers(text) {
  const found = norm(text).match(/export type ZyAgentRole\s*=([^\n]+)/)
  if (found === null) return undefined
  return [...found[1].matchAll(/'([^']+)'/g)].map(item => item[1])
}

/** 逐条比对两个列表，给出人能照着改的差异说明。 */
function diffLists(expected, actual) {
  const problems = []
  const missing = expected.filter(item => !actual.includes(item))
  const extra = actual.filter(item => !expected.includes(item))
  if (missing.length > 0) problems.push('少了 ' + missing.join(' / '))
  if (extra.length > 0) problems.push('多了 ' + extra.join(' / '))
  if (problems.length === 0 && expected.join('|') !== actual.join('|')) {
    problems.push('条目相同但顺序不同：期望 ' + expected.join(' → ') + '，实际 ' + actual.join(' → '))
  }
  return problems.join('；')
}

/**
 * 注入点判据（源码级）：对话入口必须按**任务归属**注入角色，会话池键必须带上角色。
 *
 * 为什么单列一条：roles.json 这个事实源此前有四处表示，本门禁前五项守的就是它们；
 * 2026-10-12 起多了**第五处**——服务端在对话入口把 task.agentRole 写成内核的 BF_AGENT_ROLE。
 * 那一处坏掉的样子是"谁都没发现"：roles.json 一字不改、五份 preset 一字不改、前端镜像也一字不改，
 * 而运行期所有任务都退回总管的全量面（steward 的面是 *，等于唯一入口上没有权限边界）。
 *
 * @param {string} text - server/src/api.ts 全文。
 * @returns {string[]} 问题列表；空数组表示通过。
 */
function injectionProblems(text) {
  const source = norm(text)
  const problems = []
  if (!/asAgentRole\(task\.agentRole\)/.test(source)) {
    problems.push('对话入口没有按任务归属注入（找不到 asAgentRole(task.agentRole)）')
  }
  if (/role:\s*'steward'/.test(source)) {
    problems.push("对话入口仍写死 { role: 'steward' }——steward 的面是 *，写死等于唯一入口上没有权限边界")
  }
  if (!/agentKernelKey\(taskId,\s*role\)/.test(source)) {
    problems.push('会话池键没有带上角色（找不到 agentKernelKey(taskId, role)）')
  }
  if (/agentKernels\.(get|set)\(taskId/.test(source)) {
    problems.push('会话池仍以 taskId 单键取放（同一条任务换管家会复用旧进程的旧工具面）')
  }
  return problems
}

/**
 * 取产品内核补丁里 bosom-jsonrpc 行的 agentPreset 表达式。
 *
 * 只认「!!js "…"」这一种写法：表达式必须**整体加引号**，否则 YAML 会把行内的 `?` 当显式键标记、
 * 整行解析成映射对象（2026-10-12 dev 起不来的根因）。取不到就让调用方判红。
 *
 * @param text - 补丁文件全文（或等形状的样本）。
 * @returns 表达式字符串；没有这一行或写法不对时 undefined。
 */
function presetExprOf(text) {
  const found = norm(text).match(/^\s*agentPreset:\s*!!js\s+"(.+)"\s*$/m)
  return found === null ? undefined : found[1]
}

/**
 * 真跑 agentPreset 表达式：三种情形（纯文本 / 有角色 / 无角色）各求值一次。
 *
 * 为什么必须真跑：文本上"有配置"不等于运行期有值。2026-10-12 夜的事故正是
 * `BF_TEXT_ONLY === '1' ? undefined : …` ——看着配了，纯文本会话却拿到 undefined，
 * 而当时官方 schema 被改成必填，整条纯文本链路挂了 50 分钟。判据只认运行期的值。
 *
 * @param expr - {@link presetExprOf} 取到的表达式。
 * @returns 每种情形的 `{label, value, error}`。
 */
function presetExprValues(expr) {
  const cases = [
    ['BF_TEXT_ONLY=1', '1', ''],
    ['有角色', '', 'creator'],
    ['无角色', '', ''],
  ]
  const results = []
  for (const [label, textOnly, role] of cases) {
    const savedTextOnly = process.env.BF_TEXT_ONLY
    const savedRole = process.env.BF_AGENT_ROLE
    try {
      if (textOnly === '') delete process.env.BF_TEXT_ONLY
      else process.env.BF_TEXT_ONLY = textOnly
      if (role === '') delete process.env.BF_AGENT_ROLE
      else process.env.BF_AGENT_ROLE = role
      /* eslint-disable-next-line no-new-func -- 表达式来自本仓库的配置文件，判据必须真跑它 */
      const value = new Function('return (' + expr + ')')()
      results.push({ label, value })
    } catch (error) {
      results.push({ label, value: undefined, error: String(error?.message ?? error) })
    } finally {
      if (savedTextOnly === undefined) delete process.env.BF_TEXT_ONLY
      else process.env.BF_TEXT_ONLY = savedTextOnly
      if (savedRole === undefined) delete process.env.BF_AGENT_ROLE
      else process.env.BF_AGENT_ROLE = savedRole
    }
  }
  return results
}

/** 历史形态（负向对照）：纯文本下返回 undefined——判据必须认得出它。 */
const OLD_PRESET_EXPR = "(process.env.BF_TEXT_ONLY === '1' ? undefined : (process.env.BF_AGENT_ROLE || 'steward'))"

/** 旧写法样本（负向对照）：判据必须认得出它，否则这一段是假绿。 */
const OLD_FORM_SAMPLE = [
  "takeAgentKernel(task.id, kernelOptionsOf(llmOverride, { role: 'steward' }))",
  'const existing = agentKernels.get(taskId)',
  'agentKernels.set(taskId, { client, sessionId, usedAt: Date.now() })',
].join('\n')

/** 新写法样本（正向对照）：判据必须放行它，否则门禁会退化成永远判红的噪声。 */
const NEW_FORM_SAMPLE = [
  'takeAgentKernel(task.id, kernelOptionsOf(llmOverride, { role: asAgentRole(task.agentRole) }))',
  'const key = agentKernelKey(taskId, role)',
  'agentKernels.set(key, { client, sessionId, usedAt: Date.now() })',
].join('\n')

/**
 * 按角色重放内核 apply，返回角色 → 注册的工具名。
 *
 * 走**环境变量**这条路（BF_AGENT_ROLE ＋ 临时 DSH_HOME 里的 .agent-presets/roles.json）——
 * 服务端起的那个内核进程走的就是它；config.tools 那条重放路径由 qa/verify-kernel-tools.mjs 守着。
 * 临时 home 跑完即删，不碰真实数据根。
 *
 * @param {string} libPath - 内核构建产物（kernel/lib/index.js）。
 * @param {string} rolesSource - roles.json 全文（写进临时 home 的运行期副本位置）。
 * @returns {Promise<Map<string, string[]>>} 角色 → 工具名。
 */
async function roleSurfaces(libPath, rolesSource) {
  const home = mkdtempSync(join(tmpdir(), 'bf-preset-parity-'))
  const previousHome = process.env.DSH_HOME
  const previousRole = process.env.BF_AGENT_ROLE
  try {
    mkdirSync(join(home, '.agent-presets'), { recursive: true })
    writeFileSync(join(home, '.agent-presets', 'roles.json'), rolesSource, 'utf8')
    mkdirSync(join(home, 'bosom-friend'), { recursive: true })
    process.env.DSH_HOME = home
    const mod = await import(pathToFileURL(libPath).href)
    const surfaces = new Map()
    for (const role of ['creator', 'steward']) {
      process.env.BF_AGENT_ROLE = role
      const seen = []
      mod.apply({
        tools: { register: tool => { seen.push(tool.name); return () => {} } },
        llm: {
          async *stream() {
            yield { type: 'text-delta', text: '' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        },
      })
      surfaces.set(role, seen)
    }
    return surfaces
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousRole === undefined) delete process.env.BF_AGENT_ROLE
    else process.env.BF_AGENT_ROLE = previousRole
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('门禁：管家工具面一致性（唯一事实源 presets/roles.json）')

// ---- 事实源 ----
const rolesText = readText(ROLES_JSON)
if (rolesText === undefined) {
  ok('roles-json-readable', false, '读不到 ' + ROLES_JSON)
  console.log('\n=== 门禁结果：FAIL（事实源读不到，后面无从比对） ===')
  process.exit(1)
}
let roles
try {
  roles = JSON.parse(rolesText)
} catch (error) {
  ok('roles-json-readable', false, 'roles.json 不是合法 JSON：' + String(error.message))
  console.log('\n=== 门禁结果：FAIL ===')
  process.exit(1)
}
const roleIds = Object.keys(roles)
ok('roles-json-readable', roleIds.length > 0, '事实源 ' + roleIds.length + ' 个角色：' + roleIds.join(' / '))

// ---- 1. preset 目录集合 ----
const presetDirs = roleIds.filter(role => existsSync(join(PRESET_DIR, role, 'agent.cordis.yml')))
const missingDirs = roleIds.filter(role => !presetDirs.includes(role))
ok('preset-dirs-cover-roles', missingDirs.length === 0,
  missingDirs.length === 0 ? '五个角色都有组成文件' : '缺组成文件：' + missingDirs.join(' / '))

// ---- 2. 每份 preset 的工具面 ----
for (const role of roleIds) {
  const expected = Array.isArray(roles[role]) ? roles[role] : undefined
  if (expected === undefined) {
    ok('preset-tools-' + role, false, 'roles.json 的 ' + role + ' 不是字符串数组')
    continue
  }
  const path = join(PRESET_DIR, role, 'agent.cordis.yml')
  const text = readText(path)
  if (text === undefined) {
    ok('preset-tools-' + role, false, '读不到 presets/' + role + '/agent.cordis.yml')
    continue
  }
  const actual = presetTools(text)
  if (actual === undefined) {
    ok('preset-tools-' + role, false, '它没有 bosom-kernel 的 config.tools 段（工具面缺失 = 将来接上 preset 时该管家没有任何工具）')
    continue
  }
  const problems = diffLists(expected, actual)
  ok('preset-tools-' + role, problems === '',
    problems === '' ? expected.join(' / ') : '与 roles.json 不一致：' + problems)
}

// ---- 3. 前端镜像 ----
const mirrorText = readText(FRONTEND_MIRROR)
if (mirrorText === undefined) {
  ok('frontend-mirror', false, '读不到 ' + FRONTEND_MIRROR)
} else {
  const mirror = frontendMirror(mirrorText)
  const codeProblems = diffLists(roleIds, mirror.map(item => item.code))
  if (codeProblems !== '') {
    ok('frontend-mirror', false, 'TEAM_AGENT_ROLES 的角色与 roles.json 不一致：' + codeProblems)
  } else {
    const bad = mirror
      .map(item => ({ code: item.code, problems: diffLists(roles[item.code], item.patterns) }))
      .filter(item => item.problems !== '')
    ok('frontend-mirror', bad.length === 0,
      bad.length === 0
        ? '五个管家的 toolSurface 与 roles.json 逐条一致'
        : bad.map(item => item.code + '：' + item.problems).join('；'))
  }
}

// ---- 4. 角色类型的成员 ----
const typeText = readText(ROLE_TYPE)
if (typeText === undefined) {
  ok('role-type', false, '读不到 ' + ROLE_TYPE)
} else {
  const members = roleTypeMembers(typeText)
  if (members === undefined) {
    ok('role-type', false, '找不到 export type ZyAgentRole')
  } else {
    const problems = diffLists(roleIds, members)
    ok('role-type', problems === '', problems === '' ? members.join(' | ') : 'ZyAgentRole 与 roles.json 不一致：' + problems)
  }
}

// ---- 5. 运行期副本 ----
// 内核读的是运行期副本里的 roles.json，不是仓库里的这份；仓库改了没同步过去，
// 运行期就还是旧工具面——那正是「唯一事实源」失效的样子。
//
// 路径口径与 bundle/kernel/runtime/bin-kernel.mjs 一致：BOSOM_FRIEND_HOME，否则 ~/.bosom-friend。
// 故意**不读 DSH_HOME**：内核启动时第一件事就是把 DSH_HOME 覆盖成上面这个值
// （bin-kernel.mjs:18-20），而开发会话里 DSH_HOME 指向 DSH 自己的 home（~/.dsh），
// 照它去找只会永远跳过本项——第一版就是那么写的，跑出来发现整项被跳过才改掉。
const home = (process.env.BOSOM_FRIEND_HOME ?? '').trim() !== ''
  ? process.env.BOSOM_FRIEND_HOME.trim()
  : join(homedir(), '.bosom-friend')
const live = join(home, '.agent-presets')
if (!existsSync(live)) {
  ok('runtime-copy', true, '本机没有运行期副本（' + live + '）——跳过；安装版机器上这里必须一致')
} else {
  const pairs = [['roles.json', ROLES_JSON]]
  for (const role of roleIds) pairs.push([role + '/agent.cordis.yml', join(PRESET_DIR, role, 'agent.cordis.yml')])
  const drifted = []
  const absent = []
  for (const [rel, source] of pairs) {
    const target = join(live, rel)
    if (!existsSync(target)) {
      absent.push(rel)
      continue
    }
    if (norm(readText(target) ?? '?') !== norm(readText(source) ?? '!')) drifted.push(rel)
  }
  const problems = []
  if (absent.length > 0) problems.push('运行期缺文件：' + absent.join(' / '))
  if (drifted.length > 0) problems.push('与仓库源不一致：' + drifted.join(' / ') + '（把仓库里这份复制过去，内核读的是它）')
  ok('runtime-copy', problems.length === 0,
    problems.length === 0 ? 'roles.json 与五个组成文件都与仓库源一致（' + live + '）' : problems.join('；'))
}

// ---- 6. 运行期注入点（第 11 条）----
//
// 前五项都是「静态表示之间一致」；这一项守的是**注入点本身**：服务端把 task.agentRole
// 送成内核的 BF_AGENT_ROLE，内核按它读 roles.json 切工具面。判据分三层，缺一层就有洞：
//   ① 源码级：入口按归属注入、池键带角色（{@link injectionProblems}）；
//   ② 运行时：creator 的面里真的没有发布工具，且 steward 的面里真的有（对照，防假绿）；
//   ③ 自检：把旧写法样本喂给①的判据必须判红——判据自己认不出旧写法，等于没有判据。
const apiText = readText(API_SRC)
const injection = apiText === undefined
  ? ['读不到注入点源码 ' + API_SRC]
  : injectionProblems(apiText)

const selfCheck = injectionProblems(OLD_FORM_SAMPLE).length > 0 && injectionProblems(NEW_FORM_SAMPLE).length === 0
if (!selfCheck) injection.push('判据自检失败：它认不出旧写法或误伤新写法（这一段判据本身失效，先修它）')

// ④ 组装链路活着（2026-10-12，ADR-006 的兜底）。为什么必须有这一层：官方升级会覆盖
// packages/sdk/server 里的补丁，而 schemastery **放行未知键**——patch 里的 agentPreset
// 会被静默忽略，又因为根层已把 bosom-kernel 让位给 preset，那一次会话会**一个工具都没有**
// 且全程不报错。链路三段（官方插件配置项、createSession 的真实调用、产品 patch 的配置行）
// 因此都要有常驻判据：任何一段断了，这里立刻判红并点名。
const sdkIndex = readText(join(SDK_SERVER_SRC, 'index.ts'))
const sdkServer = readText(join(SDK_SERVER_SRC, 'server.ts'))
const patchText = readText(KERNEL_PATCH)
if (sdkIndex === undefined || !/agentPreset:\s*Schema\.string\(\)/.test(sdkIndex)) {
  injection.push('官方 SDK server 的 Config 里没有 agentPreset（补丁被官方升级覆盖了？见 ADR-006：它会让 agentPreset 被静默忽略、会话零工具）')
}
if (sdkServer === undefined || !/presets\.mount\(agentCtx,\s*presetId\)/.test(sdkServer)) {
  injection.push('官方 SDK server 的 createSession 里没有 presets.mount(agentCtx, presetId)（组装调用被覆盖了？见 ADR-006）')
}
// 产品侧 fail loud（2026-10-12 夜加）：表达式必须**真跑**——只看"有没有 agentPreset"是假判据，
// 文本上"配了"、运行期却返回 undefined，正是那次 50 分钟事故的形态。三种情形都要拿到非空字符串。
let presetExprNote = ''
const presetExpr = patchText === undefined ? undefined : presetExprOf(patchText)
if (presetExpr === undefined) {
  injection.push('内核补丁层没有给 bosom-jsonrpc 配 agentPreset（或没写成 !! js "…" 的整体引号形式；配置层断线 = 会话零工具）')
} else {
  const values = presetExprValues(presetExpr)
  for (const { label, value, error } of values) {
    if (error !== undefined) injection.push('agentPreset 表达式在「' + label + '」下抛错：' + error)
    else if (typeof value !== 'string' || value.trim() === '') {
      injection.push('agentPreset 表达式在「' + label + '」下返回 ' + JSON.stringify(value) + '（必须是角色名或 none 这样的非空字符串）')
    }
  }
  presetExprNote = '；agentPreset 三情形 = ' + values.map(item => JSON.stringify(item.value)).join(' / ')
}
// 负向对照：历史形态必须被判红，否则这一段是假判据。
const presetSelfCheck = presetExprOf('- id: bosom-jsonrpc\n  config:\n    agentPreset: !!js "' + OLD_PRESET_EXPR + '"\n') !== undefined
  && presetExprValues(OLD_PRESET_EXPR).some(item => typeof item.value !== 'string' || item.value.trim() === '')
if (!presetSelfCheck) injection.push('判据自检失败：认不出"纯文本下返回 undefined"的历史形态（这一段判据本身失效，先修它）')

let surfaceNote = ''
if (!existsSync(KERNEL_LIB)) {
  injection.push('找不到内核构建产物 ' + KERNEL_LIB + '（先跑 pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel build）')
} else {
  try {
    const surfaces = await roleSurfaces(KERNEL_LIB, rolesText)
    const creator = surfaces.get('creator') ?? []
    const steward = surfaces.get('steward') ?? []
    const creatorPublish = creator.filter(name => name.startsWith('bosom_publish_'))
    const stewardPublish = steward.filter(name => name.startsWith('bosom_publish_'))
    if (creatorPublish.length > 0) {
      injection.push('creator 的工具面里出现了发布工具：' + creatorPublish.join(' / '))
    }
    if (!creator.includes('bosom_content_list_drafts')) {
      injection.push('creator 的工具面里没有 bosom_content_list_drafts（面为空或 roles.json 读错了，判据会变成假绿）')
    }
    if (stewardPublish.length === 0) {
      injection.push('对照失败：steward 的工具面里也没有发布工具（说明不是"按角色切开"，而是工具根本没注册）')
    }
    surfaceNote = '；运行时重放（env 路径）：creator ' + creator.length + ' 个工具（发布 0）、steward '
      + steward.length + ' 个（发布 ' + stewardPublish.length + '）'
  } catch (error) {
    injection.push('运行时重放 apply 抛错：' + String(error?.message ?? error))
  }
}
ok('runtime-injection-by-owner', injection.length === 0,
  injection.length === 0
    ? '对话入口按 task.agentRole 注入、池键带角色、creator 面不含发布工具' + surfaceNote + presetExprNote
    : injection.join('；'))

// ---- 汇总 ----
const failed = results.filter(item => !item.pass)
console.log('\n=== 门禁结果：' + (failed.length === 0 ? 'PASS' : 'FAIL') + '（' + (results.length - failed.length) + '/' + results.length + ' 项） ===')
if (failed.length > 0) {
  console.log('不一致项：' + failed.map(item => item.name).join(' / '))
  console.log('改法：改 presets/roles.json（唯一事实源），再把同样的列表抄到上面点名的位置；不要反向改。')
  process.exit(1)
}
process.exit(0)
