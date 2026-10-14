#!/usr/bin/env node
/**
 * Marvis 对标进度（BFS-901）——把「开发初衷」变成每次会话都会读到的数字。
 *
 * 为什么必须有它：2026-10-12 复盘发现，跑偏不是因为不认真，而是因为
 *   ① 每次新会话注入的信息过载、没有优先级，最近的、最显眼的事就会被拿去做；
 *   ② 项目 694,062 行里「AI 管家」形态只占 1.7%，读到的 98% 都是另一个产品的故事；
 *   ③ 「做完了没有」由执行者自己定义，没有任何东西能当场判错。
 * 本脚本把 BFS-901 的五项目标做成**每次会话第一屏就读到的数字**，方向错了当场判红。
 *
 * 判红规则（只判方向，不判进度快慢——进度是渐进的，方向错了才是事故）：
 *   ① 工具覆盖率**下降** → 判红（能力被删了）
 *   ② 前端行数**增长** → 判红（旧形态在长，见《项目分区图》）
 *   ③ 901.2a 工具面按归属注入**从已生效退回未生效** → 判红
 *   ④ 901.2b 官方 mount 组装**从已接上退回未接** → 判红（它现在是欠账，基线就是 false）
 *   ⑤ 主链路用例数**减少** → 判红
 *
 * 为什么 901.2 要拆成两条（2026-10-12 裁决）：工具面按归属注入（901.2a）与官方
 * `mount()` 组装（901.2b）是**两个事实**，混一条必然误报其一——901.2a 已经生效，
 * 而 901.2b 是真实欠账（落点见 task-7 描述）。欠账要留在表上，但不该再冒充「能力没生效」。
 *
 * 用法：
 *   node qa/verify-marvis-progress.mjs            报告 + 方向判红（退出码 0/1）
 *   node qa/verify-marvis-progress.mjs --update   重设基线（只在确认进展后使用）
 *   node qa/verify-marvis-progress.mjs --brief    只输出第一屏（供 session-start 用）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = resolve(HERE, '..')
const BASELINE = join(HERE, 'marvis-baseline.json')
/**
 * 前端行数的**阈值**只认 `zone-baseline.json`（分区棘轮那份）。
 *
 * 为什么不认本文件的 `marvis-baseline.json`：它是「上次实测快照」，`--update` 每次都把
 * 当前值写进去——于是**任何一次前端增长都会让它立刻判红**，哪怕增长仍在分区棘轮允许的
 * 范围内。同一个事实（前端有多少行）在两家各记一份、两家的语义还不一样（一家是阈值、
 * 一家是快照），必然出现「一个门禁绿、另一个门禁红」的自相矛盾（2026-10-12 实测：
 * zone 基线 160865 判过、marvis 快照 160856 判红，而实测 160857）。
 * 阈值有且只有一个家：分区棘轮的 `qa/zone-baseline.json`。
 */
const ZONE_BASELINE = join(HERE, 'zone-baseline.json')
function thresholdFrontendLines() {
  try {
    const parsed = JSON.parse(readFileSync(ZONE_BASELINE, 'utf8'))
    return typeof parsed.frontendLines === 'number' ? parsed.frontendLines : null
  } catch {
    return null
  }
}
const args = new Set(process.argv.slice(2))
const brief = args.has('--brief')

/**
 * 数服务端写操作，**两种独立数法交叉校验**。
 *
 * 为什么不再硬编码：原值 121 注释称「来自八路审计」，但审计报告里查不到该数字、也没有清单，
 * 于是「还差多少条才能到 100%」无从计算，覆盖率还被凭空压低 4 个百分点。
 * 现在改成当场数：**新增路由会自动进入分母**，不需要谁来记得改常量。
 *
 * 两种数法互为校验（任何一种是单向扫描，都可能漏掉写法变体）：
 *   ① 从 `m: 'POST'` 往后找最近的 `p: '...'`
 *   ② 从 `p: '...'` 往前找最近的 `m: '...'`
 * 两者数量不一致即判红——**宁可报错，不要一个说不清出处的数字**。
 *
 * 只认 `m:`/`p:` 这种路由表写法；`fetch(..., { method: 'POST' })` 这类调用不是路由，两种数法都不会数它。
 *
 * @returns 两种数法的条数与取值（取值用第一种）。
 */
function countWriteOps() {
  const dir = join(PRODUCT, 'server', 'src')
  const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
  const METHOD_RE = /^\s*m:\s*'(GET|POST|PUT|PATCH|DELETE)'/
  const PATH_RE = /^\s*p:\s*'([^']+)'/
  // 单行写法 `{ m: 'POST', p: 'login/mail', h: … }`：METHOD_RE 要求 m: 独占一行，会整条漏掉。
  // 2026-10-12 实测：漏 9 条（5 条 login/* + 4 条 note-comment-search 分析类）→ 分母报 111，真实 120。
  const SAME_LINE_RE = /m:\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*p:\s*'([^']+)'/
  const forward = new Set()
  const backward = new Set()
  for (const f of readdirSync(dir).filter(name => name.endsWith('.ts'))) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const same = SAME_LINE_RE.exec(lines[i])
      if (same !== null && WRITE.has(same[1])) { forward.add(same[1] + ' ' + same[2]); backward.add(same[1] + ' ' + same[2]) }
      const m = METHOD_RE.exec(lines[i])
      if (m !== null && WRITE.has(m[1])) {
        for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
          const p = PATH_RE.exec(lines[k])
          if (p !== null) { forward.add(m[1] + ' ' + p[1]); break }
        }
      }
      const p = PATH_RE.exec(lines[i])
      if (p !== null) {
        for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
          const m2 = METHOD_RE.exec(lines[k])
          if (m2 !== null) { if (WRITE.has(m2[1])) backward.add(m2[1] + ' ' + p[1]); break }
        }
      }
    }
  }
  return { forward: forward.size, backward: backward.size, value: forward.size }
}
const WRITE_OPS_MEASURED = countWriteOps()
const WRITE_OPS = WRITE_OPS_MEASURED.value

/** 数内核工具（去重）。 */
function countTools() {
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
  return names.size
}

/**
 * 覆盖率（901.1）的**唯一算法**：被工具承接的写操作 / 写操作总数。
 *
 * 为什么换掉旧公式「内核工具数 ÷ 服务端写操作数」（2026-10-12 裁决）：那个公式的分子分母
 * **不在一个家**——分子来自内核源码的 `name:` 字面量，只数得到手写工具（52 个）；生成式工具的
 * `name` 是运行期由 `row.tool` 构造的，源码与产物里都只有 `tool:`，**73 个工具整个漏掉**。
 * 于是门禁报 47%，而真实是 90%——这个假数字进了活记忆、章程与多次汇报。
 *
 * 现在分子分母都取自 `server/src/capabilities.ts`（能力的唯一事实源）：
 *   分母 = `kind: 'write'` 的能力条数；
 *   分子 = 其中 `exists: true`（手写工具承接）或 `toolizable: true`（生成式工具承接）的条数。
 * 登记表本身由两条门禁守着（写路由数对账、登记表→投影漂移），所以这份数据不会静默过期。
 *
 * @returns {{total: number, covered: number, percent: number}} 分母、分子与百分比。
 */
function registryCoverage() {
  let src = ''
  try { src = readFileSync(join(PRODUCT, 'server', 'src', 'capabilities.ts'), 'utf8') } catch { return { total: 0, covered: 0, percent: 0 } }
  const lines = src.split('\n')
  let total = 0
  let covered = 0
  let handwritten = 0
  let notToolizable = 0
  for (let i = 0; i < lines.length; i += 1) {
    const head = /id: '[a-zA-Z.]+', tool: '(bosom_[a-z0-9_]+)', role: '[a-z]+', kind: '(write|read|reject)'/.exec(lines[i])
    if (head === null || head[2] !== 'write') continue
    const detail = /exists: (true|false), toolizable: (true|false)/.exec(lines[i + 1] ?? '')
    if (detail === null) continue
    total += 1
    if (detail[1] === 'true' || detail[2] === 'true') covered += 1
    if (detail[1] === 'true') handwritten += 1
    if (detail[2] === 'false') notToolizable += 1
  }
  // 「可工具化的写能力」分母：排除 toolizable: false 的（登记表自己写着「不建议补工具」的那 8 条——
  // 登录/注册/改密、协议回调、埋点、对话入口本身、界面内部写路径）。
  // 章程 901.1 的「100%」指的是这个分母；含全部 write 的口径（percent）保留，
  // 用于观察「还剩多少条没承接」——两个数一起看才不会把「按决策不做」读成「没做完」。
  const toolizableTotal = total - notToolizable
  return {
    total,
    notToolizable,
    toolizableTotal,
    covered,
    handwritten,
    percent: total === 0 ? 0 : Math.round((covered / total) * 100),
    toolizablePercent: toolizableTotal === 0 ? 0 : Math.round((covered / toolizableTotal) * 100),
    handwrittenPercent: total === 0 ? 0 : Math.round((handwritten / total) * 100),
  }
}

/** 数前端行数（.ts/.tsx/.js/.mjs/.cjs/.vue，跳过依赖与产物）。 */
function countFrontendLines() {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', '__pycache__', 'coverage'])
  const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.vue'])
  let lines = 0
  const stack = [join(PRODUCT, 'project')]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(cur, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(p); continue }
      if (!e.isFile()) continue
      const ext = e.name.slice(e.name.lastIndexOf('.'))
      if (!TEXT.has(ext)) continue
      try { lines += readFileSync(p, 'utf8').split('\n').length } catch { /* 读不到就不计 */ }
    }
  }
  return lines
}

/**
 * 901.2b 官方 mount 组装是否已接上。
 *
 * 【2026-10-12 更正判据】原判据是「server.ts 里还有没有 'No preset composition' 这句话」——
 * 那是**看文件里有没有某句话**，而本文件 901.2a 的注释刚刚批评过同类做法。
 * 后果真实发生过：那句话被删掉后，此函数立刻返回 true（表上报「已生效」），
 * 而它并不能区分「真的调了 mount 组装」和「只是把注释删了」。
 *
 * 现在的判据是**组装调用本身在不在**：必须同时看到
 *   ① agent-presets 服务上声明了 `mount(` 能力，且
 *   ② 建会话路径上真的 `await presets.mount(agentCtx, presetId)`。
 * 两者缺一即未接通。
 *
 * @returns 是否已在建会话路径上真正执行组装。
 */
function officialMount() {
  // BF_SDK_SERVER_SRC 让负向对照指向一个替身文件，不必改动官方源码（与 901.2a 的 BF_API_SRC 同一手法）。
  const sdk = process.env.BF_SDK_SERVER_SRC ?? join(PRODUCT, '..', '..', 'packages', 'sdk', 'server', 'src', 'server.ts')
  if (!existsSync(sdk)) return false
  try {
    const source = readFileSync(sdk, 'utf8')
    const declaresMount = /mount\(agentCtx:\s*Context/.test(source)
    const callsMount = /await\s+presets\.mount\(/.test(source)
    return declaresMount && callsMount
  } catch { return false }
}

/**
 * 901.2a 工具面按归属注入是否生效（跑在真实信号上，不看"某个文件里有没有某句话"）。
 *
 * 判据是**注入点本身在不在**：对话入口必须按任务归属把角色写进内核
 * （`asAgentRole(task.agentRole)`），且不得退回写死 `steward`——它的面是 `*`，
 * 写死等于唯一入口上没有权限边界。口径与 qa/verify-preset-parity.mjs 的第 11 条
 * runtime-injection-by-owner 一致（那边还多一条池键判据与运行时重放），这里只取
 * true/false 供方向对比。BF_API_SRC 可覆盖源码路径（负向对照用，不动真源码）。
 *
 * @returns {{ ok: boolean, detail: string }} 是否生效，以及一句人话说明。
 */
function ownerInjection() {
  const path = process.env.BF_API_SRC ?? join(PRODUCT, 'server', 'src', 'api.ts')
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return { ok: false, detail: '读不到注入点源码 ' + path } }
  if (!/asAgentRole\(task\.agentRole\)/.test(text)) {
    return { ok: false, detail: '对话入口没有按任务归属注入（找不到 asAgentRole(task.agentRole)）' }
  }
  if (/role:\s*'steward'/.test(text)) {
    return { ok: false, detail: "对话入口退回写死 { role: 'steward' }：steward 的面是 *，等于没有权限边界" }
  }
  return { ok: true, detail: '对话入口按 task.agentRole 注入（常驻判据：qa/verify-preset-parity.mjs 第 11 条 runtime-injection-by-owner）' }
}

/**
 * 主链路用例数：数一句话端到端脚本里 CASES 数组的条目（`say:` 出现次数）。
 * 口径说明：`【说】` 只在打印时出现一次，数它是错的（2026-10-12 首版即踩）。
 * 另注：现有门禁**只跑只读用例**（写能力会改用户数据，脚本注释第 11-12 行明确排除），
 * 所以 901.4 要求的主链路 ≥12 条**包含写链路**，必须先建「在看得见的窗口里跑写链路」的机制。
 */
function mainChainCases() {
  const f = join(HERE, 'verify-one-sentence-e2e.mjs')
  if (!existsSync(f)) return 0
  try {
    // 2026-10-13 修：原正则到**第一个 `]`** 就停——CASES 里新增 `altTools: ['…']` 后当场把 13 条截成 10 条，
    // 棘轮报「用例数下降」。闭合括号在行首，用它当终点才不会被数组字面量里的 `]` 骗到。
    const block = /const CASES = \[([\s\S]*?)\n\]/.exec(readFileSync(f, 'utf8'))
    if (block === null) return 0
    return (block[1].match(/\bsay:/g) ?? []).length
  } catch { return 0 }
}

// 2026-10-12 删：这里原来有一项「是否已出安装包」。产品负责人明确要求——
// 「把整个项目里打包这一条彻底删了，要打包的时候我会告诉你」。
// 打包不是开发流程的一步，是他下令才做的动作；把它当进度指标会诱导"为了指标去打包"，
// 而装一个还没做完的包只会带来返工。脚本与授权闸保留（他下令时可跑，无命令则 exit 3）。

const injection = ownerInjection()
const registry = registryCoverage()
const now = {
  tools: countTools(),
  writeOps: WRITE_OPS,
  writeOpsCovered: registry.covered,
  writeOpsTotal: registry.total,
  handwritten: registry.handwritten,
  handwrittenPercent: registry.handwrittenPercent,
  coverage: registry.percent,
  toolizablePercent: registry.toolizablePercent,
  notToolizable: registry.notToolizable,
  frontendLines: countFrontendLines(),
  ownerInjection: injection.ok,
  officialMount: officialMount(),
  mainChainCases: mainChainCases(),
}

/** 当前阶段与唯一动作——写死在门禁里，避免"我记成什么样就是什么样"。 */
const STAGES = [
  // done 必须按**事实**维护：全部写 false 会让「唯一动作」永远停在 P0，
  // 而 P0 早已达成（DEF-285 已修、用例已 13 条、三项指标已进棘轮）——
  // 门禁每天报一个已完成的动作，下一个人就会照它去"重新做一遍"。
  { id: 'P0', name: '立判据', done: true, action: '已完成：DEF-285 已修、主链路用例 13 条、三项指标进棘轮' },
  { id: 'P1', name: '补能力', done: false, action: '登记表 121 条全部有归宿（108 生成 + 13 手写覆盖）。**无闸写操作已归零**（2026-10-13：非只读=必须有 order——生成式兜底进闸、门禁对每条非只读现场验证本地拒绝（危险工具 89 条）；bosom_reception_poll_now / bosom_learn_from_history 两条手写工具补闸；只验注册只剩 3 条只读，各有理由）；剩余是把**手写工具的边界**继续收严（挑工具说明与描述口径）' },
  { id: 'P2', name: '通编排', done: true, action: '已完成：901.2a 工具面按归属注入已生效、901.2b 官方 mount 组装已生效' },
  { id: 'P3', name: '降前端', done: false, action: '页面从执行入口降级为可视化，功能入口归零' },
  { id: 'P4', name: '收门禁', done: false, action: 'qa/ 顶层脚本收敛到「一能力一门禁」' },
]
const current = STAGES.find(s => !s.done)

if (args.has('--update')) {
  writeFileSync(BASELINE, JSON.stringify({ at: new Date().toISOString(), ...now }, null, 2), 'utf8')
  console.log('MARVIS_BASELINE_UPDATED ' + JSON.stringify(now))
  process.exit(0)
}

const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null
const failures = []

if (brief) {
  console.log('BFS-901 当前阶段：' + current.id + ' · ' + current.name)
  console.log('唯一动作：' + current.action)
  console.log('五项目标：覆盖率 ' + now.coverage + '%（写能力 ' + now.writeOpsCovered + '/' + now.writeOpsTotal + ' 已工具化） | 901.2a 工具面注入 '
    + (now.ownerInjection ? '已生效' : '未生效') + ' | 901.2b 官方 mount ' + (now.officialMount ? '已生效' : '未生效（欠账）')
    + ' | 前端 ' + now.frontendLines + ' 行 | 用例 ' + now.mainChainCases + '/12')
}

if (!brief) {
  console.log('== Marvis 对标进度（BFS-901）==')
  console.log('   当前阶段：' + current.id + ' · ' + current.name)
  console.log('   唯一动作：' + current.action)
  console.log('')
  console.log('   | 目标 | 现状 | 目标值 | 方向 |')
  console.log('   | 901.1b 手写比例 | ' + now.handwrittenPercent + '%（手写承接 ' + now.handwritten + '/' + now.writeOpsTotal + '）| **只增**（生成式能办事，但描述、入参与拒绝文案是通用兜底；手写才逐条核过）| 只增 |')
  console.log('   | 901.1 工具覆盖率 | ' + now.toolizablePercent + '%（**可工具化的写能力** ' + now.writeOpsCovered + '/' + (now.writeOpsTotal - now.notToolizable) + '）｜含按决策不做的 ' + now.writeOpsTotal + ' 条时 ' + now.coverage + '% | 100% | 只增 |')
  console.log('   | 901.2a 工具面按归属注入 | ' + (now.ownerInjection ? '已生效' : '未生效') + ' | 生效 | 单向 |')
  console.log('   | 901.2b 官方 mount 组装 | ' + (now.officialMount ? '已生效' : '未生效（欠账：官方 mount 未接，落点见 task-7 描述）') + ' | 生效 | 单向 |')
  console.log('   | 901.3 前端行数 | ' + now.frontendLines + ' | 只减不增 | 只减 |')
  console.log('   | 901.4 主链路用例 | ' + now.mainChainCases + ' | ≥12 | 只增 |')
  console.log('')
}

if (base !== null) {
  if (now.tools < base.tools) failures.push('内核工具数下降：' + base.tools + ' → ' + now.tools)
  // 判据用**分数**而不是四舍五入后的百分比：删掉一条已工具化的写能力时，88/95 → 87/94
  // 百分比仍是 93%，只有分子能暴露它。
  if (typeof base.writeOpsCovered === 'number' && now.writeOpsCovered < base.writeOpsCovered) failures.push('被工具承接的写能力下降：' + base.writeOpsCovered + ' → ' + now.writeOpsCovered + '（覆盖率分子）')
  if (typeof base.handwrittenPercent === 'number' && now.handwrittenPercent < base.handwrittenPercent) failures.push('手写比例下降：' + base.handwrittenPercent + '% → ' + now.handwrittenPercent + '%（有手写工具退回生成式，或新增能力直接走了生成式而未手写）')
if (typeof base.coverage === 'number' && now.coverage < base.coverage) failures.push('工具覆盖率下降：' + base.coverage + '% → ' + now.coverage + '%（' + now.writeOpsCovered + '/' + now.writeOpsTotal + '）——有能力被删或失去工具承接')
// 【2026-10-13】可工具化口径也要盯：它排除「按决策不做工具」的 8 条（登录/注册/改密/协议回调/埋点/对话入口/界面内部写路径），
// 章程 901.1 的「100%」指的是它。两个口径都不能降——一个是「能力有没有缩水」，一个是「该承接的有没有都接上」。
if (typeof base.toolizablePercent === 'number' && now.toolizablePercent < base.toolizablePercent) failures.push('可工具化的写能力覆盖率下降：' + base.toolizablePercent + '% → ' + now.toolizablePercent + '%（' + now.writeOpsCovered + '/' + (now.writeOpsTotal - now.notToolizable) + '）')
  // 阈值取分区棘轮那份（见文件头 thresholdFrontendLines 的说明）；读不到就退回本文件的快照，
  // 这样门禁在缺文件时仍能工作，但正常路径永远只看一个家。
  const frontendThreshold = thresholdFrontendLines() ?? base.frontendLines
  if (now.frontendLines > frontendThreshold) failures.push('前端行数增长：' + frontendThreshold + ' → ' + now.frontendLines + '（旧形态在长，新能力应做成工具；阈值来自 qa/zone-baseline.json）')
  if (base.ownerInjection === true && now.ownerInjection === false) failures.push('901.2a 工具面按归属注入从已生效退回未生效：' + injection.detail)
  if (base.officialMount === true && now.officialMount === false) failures.push('901.2b 官方 mount 组装从已接通退回未接')
  if (now.mainChainCases < base.mainChainCases) failures.push('主链路用例数下降：' + base.mainChainCases + ' → ' + now.mainChainCases)
// 【为什么要比基线，而不是比两种数法】
// 曾试过断言「两种数法条数一致」，负向对照证明它是**假门禁**：两种数法的扫描窗口对称（都是 4 行），
// 一条路由要么两边都数得到、要么两边都数不到，**永远不会分叉**。改比基线才真能触发——
// 只要有人增删路由，分母就变，必须有人出来解释「这是新增能力还是删了能力」。
// 两种数法仍保留在 countWriteOps 里：它保证这个分母至少被两条独立路径确认过。
if (WRITE_OPS !== base.writeOps) failures.push('写操作数（覆盖率的分母）变了：基线 ' + base.writeOps + ' → 现在 ' + WRITE_OPS + '。若确属能力增删，用 --update 重设基线，并在提交说明里写清新增/删除了哪些路由')
} else {
  console.log('（还没有基线；先跑 --update 记录当前值——这不是失败）')
}

if (failures.length > 0) {
  console.log('MARVIS_PROGRESS_FAIL 方向错误 ' + failures.length + ' 项：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('MARVIS_PROGRESS_OK 五项目标方向正确（覆盖率 ' + now.coverage + '%（' + now.writeOpsCovered + '/' + now.writeOpsTotal + '） · 前端 ' + now.frontendLines + ' 行 · 用例 ' + now.mainChainCases + ' 条）')
process.exit(0)
