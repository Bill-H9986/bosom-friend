/**
 * 事实源提取器（**文件级读取**，不受 .gitignore/ripgrep 影响）。
 * 任何提取失败都抛错 —— 空集绝不能变成「一致」。
 *
 * 契约（CLI parser 事实）**每次现提取**，由调用方传入路径；不读快照，避免快照本身成为漂移源。
 */
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PRODUCT = join(HERE, '..', '..')          // products/bosom-friend

function read(rel) {
  const p = join(PRODUCT, rel)
  if (!existsSync(p)) throw new Error('EXTRACTION_FAILED: 文件不存在 ' + rel)
  return readFileSync(p, 'utf8')
}
function extractStringArray(src, name, rel) {
  const m = new RegExp('const\\s+' + name + '[^=]*=\\s*\\[([^\\]]*)\\]', 's').exec(src)
  if (!m) throw new Error('EXTRACTION_FAILED: 找不到 ' + name + ' @ ' + rel)
  const items = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
  if (items.length === 0) throw new Error('EXTRACTION_FAILED: ' + name + ' 提取到空集 @ ' + rel)
  return items
}

/**
 * 提取「QA 默认基址端口」与「服务端权威端口」。
 *
 * 权威端口取自启动脚本实际监听的端口（dev-web.ps1 的 -LocalPort），
 * **不是**取"当前这台机器恰好跑在哪个端口"。
 * 提取失败一律抛 EXTRACTION_FAILED —— 空集不能变成"一致"。
 */
export function loadAddressFacts({ mutate = null } = {}) {
  const QA_DIR = join(PRODUCT, 'qa')
  const qaBasePorts = []
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
      if (!/\.(mjs|ts)$/.test(e.name)) continue
      const text = readFileSync(p, 'utf8')
      if (!text.includes('BF_QA_BASE')) continue
      // 只取「默认值位置」的端口：BF_QA_BASE || / ?? 'http://127.0.0.1:PORT/...'
      for (const m of text.matchAll(/BF_QA_BASE\s*(?:\|\||\?\?).{0,40}?127\.0\.0\.1:(\d+)/g))
        qaBasePorts.push({ file: p.slice(QA_DIR.length + 1), port: Number(m[1]) })
    }
  }
  walk(QA_DIR)
  if (qaBasePorts.length === 0) throw new Error('EXTRACTION_FAILED: 未提取到任何 QA 默认基址端口')

  const devweb = readFileSync(join(PRODUCT, 'launcher', 'scripts', 'dev-web.ps1'), 'utf8')
  // 端口参数名在 2026-10-13 由 -LocalPort 改为 -Port（dev-web.ps1 加隔离能力时一并规范化）。
  // 两种写法都认：改一处参数名就把整个漂移门禁打崩，是当天真实发生过的事。
  // 端口写法在 2026-10-13 变了：原来是 `-LocalPort 31280`，加隔离能力后规范成参数默认值
  // `[int]$Port = 31280`。两种都认——改一处参数名就把整个漂移门禁打崩，是当天真实发生过的事。
  const listen = /\$Port\s*=\s*(\d+)/.exec(devweb) ?? /-LocalPort\s+(\d+)/.exec(devweb)
  if (!listen) throw new Error('EXTRACTION_FAILED: dev-web.ps1 未找到 $Port = <n> 或 -LocalPort <n>')
  const serverPort = Number(listen[1])

  const out = { qaBasePorts, serverPort }
  // 自证注入：把某个脚本的端口改成错误值
  if (mutate === 'qa-base-address') out.qaBasePorts = [...out.qaBasePorts, { file: 'INJECTED.mjs', port: 65535 }]
  return out
}

/**
 * 死代码取证：**三维独立**，不混淆代码事实与开发者意图。
 *
 *   使用状态：有没有有效消费路径（引用分析）
 *   意图状态：是否用**结构化标记**声明了保留原因（自由文本注释只作辅助，不参与判定）
 *   证据状态：本次扫描能否支撑结论（动态访问无法排除时必须 UNVERIFIED）
 *
 * 范围**只覆盖登记在册的对象**，不做全仓死代码扫描。
 */
const DEAD_CANDIDATES = [
  {
    id: 'store.channels',
    note: 'store.ts 的 channels 常量表',
    scanRoots: ['server/src', 'kernel/src'],
    defFile: 'server/src/store.ts',
    defPattern: /^\s*channels:\s*\[/m,
    // 消费点：成员访问或解构赋值（定义所在行不算）
    usePatterns: [/\.channels\b/, /\{\s*[^}\n]*\bchannels\b[^}\n]*\}\s*=/],
    // 动态访问：命中则无法排除间接消费 → UNVERIFIED
    dynamicPatterns: [/Object\.(keys|values|entries)\(\s*store\b/, /\.\.\.\s*store\b/, /for\s*\(\s*(?:const|let|var)\s+\w+\s+in\s+store\b/],
  },
  {
    id: 'PLATFORM_CONSTRAINTS',
    note: '前端平台约束表',
    scanRoots: ['project/bosom-friend-web/src'],
    defFile: null,
    defPattern: /const\s+PLATFORM_CONSTRAINTS[^=]*=\s*\{\s*\}/,
    usePatterns: [/PLATFORM_CONSTRAINTS\[/, /PLATFORM_CONSTRAINTS\./],
    dynamicPatterns: [/Object\.(keys|values|entries)\(\s*PLATFORM_CONSTRAINTS\b/, /\.\.\.\s*PLATFORM_CONSTRAINTS\b/],
    // 空值守卫：读取点是否显式处理"查不到约束"（正则近似，作为附加证据报告）
    guardPattern: /if\s*\(\s*\w+\s*&&[^)]*\bvideoCategories\b/,
  },
];

/** 结构化保留标记：只有显式标记才算"声明了保留原因"，自由文本注释不算。 */
/**
 * 字段契约：声明每个被监控字段是**必需链路**还是**可选字段**。
 * 必需：消费者存在而生产者缺失 = 接线断裂 → DRIFT。
 * 可选：平台本来就可能没有该数据（无生产者是合法状态）→ 不报 DRIFT，如实标注。
 * 这不是例外表：例外表是"压制已知不一致"，契约是"声明该字段本来的性质"。
 */
const FIELD_CONTRACTS = {
  'topic.maxTotalLength': {
    required: false,
    note: '平台话题总字符数上限；无可核查官方数据时后端不生成数值（DEF-231）',
  },
  maxTotalTextLength: {
    retired: true,
    note: '已随 DEF-230 删除：语义自相矛盾（同时被当作标题+正文总长与话题总长），且无平台出处',
  },
}

const INTENT_MARKERS = [/@reserved\b/, /@keep\b/, /@intentional\b/, /@dead-code-ok\b/];

function readTree(root) {
  const acc = []
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (!['node_modules', 'dist', 'lib'].includes(e.name)) walk(p); continue }
      // 统一成正斜杠：Windows 上 join 产出反斜杠，会导致 defFile 的 endsWith 永远失败
      if (/\.(ts|tsx|mts)$/.test(e.name)) acc.push({ file: p.slice(PRODUCT.length + 1).split('\\').join('/'), text: readFileSync(p, 'utf8') })
    }
  }
  if (existsSync(root)) walk(root)
  return acc
}

export function loadDeadFacts({ mutate = null } = {}) {
  const objects = []
  for (const c of DEAD_CANDIDATES) {
    const files = c.scanRoots.flatMap(r => readTree(join(PRODUCT, r)))
    if (files.length === 0) throw new Error('EXTRACTION_FAILED: ' + c.id + ' 扫描范围为空')
    // ① 定义位置
    const defHit = files.find(f => c.defPattern.test(f.text) && (!c.defFile || f.file.endsWith(c.defFile)))
    // ② 消费点
    const uses = []
    for (const f of files) {
      const lines = f.text.split(/\r?\n/)
      lines.forEach((ln, i) => {
        if (c.defPattern.test(ln) && (!c.defFile || f.file.endsWith(c.defFile))) return  // 定义行本身不算消费
        if (c.usePatterns.some(p => p.test(ln))) uses.push({ file: f.file, line: i + 1 })
      })
    }
    // ③ 动态访问
    const dynamicHits = []
    for (const f of files) {
      const lines = f.text.split(/\r?\n/)
      lines.forEach((ln, i) => { if (c.dynamicPatterns.some(p => p.test(ln))) dynamicHits.push({ file: f.file, line: i + 1 }) })
    }
    // ④ 意图（只看结构化标记，且只看定义处附近）
    let intent = 'none'
    if (defHit) {
      const lines = defHit.text.split(/\r?\n/)
      const at = lines.findIndex(l => c.defPattern.test(l))
      const window = lines.slice(Math.max(0, at - 25), at + 1).join('\n')
      if (INTENT_MARKERS.some(m => m.test(window))) intent = 'reserved'
    }
    // ⑤ 空值守卫（仅登记了 guardPattern 的对象）
    const guardOk = c.guardPattern ? files.some(f => c.guardPattern.test(f.text)) : null

    objects.push({ id: c.id, note: c.note, defFound: !!defHit, defFile: defHit?.file ?? null, uses, dynamicHits, intent, guardOk })
  }

  // 自证注入（只在内存里，不写文件）
  if (mutate === 'dead-code') {
    const o = objects.find(x => x.id === 'store.channels')
    o.uses = [...o.uses, { file: 'INJECTED-consumer.ts', line: 1 }]
  }
  if (mutate === 'dead-code-dynamic') {
    const o = objects.find(x => x.id === 'store.channels')
    o.dynamicHits = [...o.dynamicHits, { file: 'INJECTED-dynamic.ts', line: 1 }]
  }
  if (mutate === 'dead-code-scan') throw new Error('EXTRACTION_FAILED: 注入的扫描失败')

  return { objects }
}

/**
 * 约束关系取证 —— **三个事实分开**：
 *   数值事实：从代码提取（检测器只读数）
 *   关系声明：从**结构化标记**提取（必须绑定 relation + target，缺一即无效）
 *   关系验证：由规则计算（本函数不给结论）
 */
export function loadConstraintFacts({ mutate = null } = {}) {
  const OBJ = 'server/src/object-actions.ts'
  const CAT = 'server/src/platform-catalog.ts'
  const objText = read(OBJ), routeText = read('server/src/routes-channels.ts')
  // catText 可被 mutate 改名，用于验证「表结构无法解析 → EXTRACTION_FAILED」
  // 走的是**与真实提取完全相同**的那条 tableParsed 判定分支（不是另写一套规则）
  let catText = read(CAT)
  if (mutate === 'constraint-notable')
    catText = catText.replace('export const PLATFORM_CONTENT_LIMITS', 'export const PLATFORM_CONTENT_LIMITS_RENAMED')

  const num = (re, text, label) => {
    const m = re.exec(text)
    if (!m) throw new Error('EXTRACTION_FAILED: 提取不到 ' + label)
    return Number(m[1])
  }
  let declaredTopicPlatforms = []
  const numbers = {
    MAX_TOPICS: num(/export const MAX_TOPICS = (\d+)/, objText, 'MAX_TOPICS'),
    MAX_TITLE_CHARS: num(/export const MAX_TITLE_CHARS = (\d+)/, objText, 'MAX_TITLE_CHARS'),
    MAX_NOTE_CHARS: num(/export const MAX_NOTE_CHARS = (\d+)/, objText, 'MAX_NOTE_CHARS'),
  }
  // 关系必须对**所有已声明话题上限的平台**成立，不是只对小红书：
  //   MAX_TOPICS <= min(适用平台已声明的话题上限)
  const topicDecls = [...catText.matchAll(/(\w+):\s*\{\s*name:\s*'([^']+)'[^}]*?body:\s*(\d+)[^}]*?topics:\s*(\d+)/g)]
    .map(m => ({ platform: m[1], name: m[2], body: Number(m[3]), topics: Number(m[4]) }))
  // **区分「合法空集」与「提取失败」**（2026-10-09 退役 xhs.topics 后的产品决策）：
  //   - 表结构**可解析**（匹配到 PLATFORM_CONTENT_LIMITS 声明）但没有任何已声明话题上限
  //     → 合法空集：不设 minDeclaredTopics，由判据报 NOT_APPLICABLE（**不等于约束已满足**）
  //   - 表结构**无法解析** → EXTRACTION_FAILED（**不得伪装成空集**）
  const tableParsed = /export const PLATFORM_CONTENT_LIMITS\s*:\s*Record</.test(catText)
  if (topicDecls.length === 0 && !tableParsed)
    throw new Error('EXTRACTION_FAILED: 限制表结构无法解析（未匹配到 PLATFORM_CONTENT_LIMITS 声明）')
  declaredTopicPlatforms = topicDecls
  for (const d of topicDecls) {
    numbers['PLATFORM_CONTENT_LIMITS.' + d.platform + '.body'] = d.body
    numbers['PLATFORM_CONTENT_LIMITS.' + d.platform + '.topics'] = d.topics
  }
  // 合法空集时**不写** minDeclaredTopics：判据据此报 NOT_APPLICABLE，而不是拿一个编造的下限去比
  if (topicDecls.length > 0) numbers['minDeclaredTopics'] = Math.min(...topicDecls.map(d => d.topics))

  // 关系声明：结构化标记；relation 与 target 必须**同块出现**才算有效声明
  const scanDecls = (text, file) => {
    const acc = []
    for (const m of text.matchAll(/@constraintRelation\s+(\S+)([\s\S]{0,240}?)\*\//g)) {
      const body = m[2]
      const t = /@constraintTarget\s+(\S+)/.exec(body)
      const r = /@constraintRationale\s+(\S+)/.exec(body)
      // 缺 target 的标记**无效**：标记本身也会漂移，必须绑定对象
      if (!t) { acc.push({ file, relation: m[1], target: null, rationale: r?.[1] ?? null, valid: false }); continue }
      acc.push({ file, relation: m[1], target: t[1], rationale: r?.[1] ?? null, valid: true })
    }
    return acc
  }
  let declarations = [...scanDecls(objText, OBJ), ...scanDecls(catText, CAT)]

  // 生产者 / 消费者：按**字段契约**判定（必需链路 vs 可选字段），不是硬编码一个字段名
  const allText = [read('server/src/store.ts'), routeText, objText, catText,
    read('project/bosom-friend-web/src/api/channels/channel.types.ts'),
    read('project/bosom-friend-web/src/components/PublishDialog/hooks/usePubParamsVerify.tsx'),
    read('project/bosom-friend-web/src/store/platformMetadata/utils.ts'),
    read('project/bosom-friend-web/src/store/platformMetadata/index.ts')].join('\n')
  const fields = {}
  for (const [name, contract] of Object.entries(FIELD_CONTRACTS)) {
    if (contract.retired) continue   // 已随缺陷修复删除的字段，不再监控
    // 用 split/join 计数：本文件在生成代码时踩过三次正则转义，这里彻底不用正则
    const count = sub => allText.split(sub).length - 1
    const typeOnly = count(name + '?:')
    const producers = count(name + ':') - typeOnly
    const consumers = count('.' + name)
    fields[name] = { required: contract.required, note: contract.note, producers, consumers, typeOnly }
  }
  const out = { numbers, declarations, topicPlatforms: declaredTopicPlatforms, fields }

  // 自证注入（只在内存）
  if (mutate === 'constraint-decl' || mutate === 'constraint-violate') {
    out.declarations = [...out.declarations,
      { file: 'INJECTED.ts', relation: 'gen-le-platform', target: 'PLATFORM_CONTENT_LIMITS.*.topics', rationale: 'shared-multiplatform-draft', valid: true },
      { file: 'INJECTED.ts', relation: 'same-source', target: 'MAX_TITLE_CHARS', rationale: 'single-definition', valid: true }]
  }
  // 平台上限降到低于生成上限 → 即使声明仍在，也必须报 DRIFT
  // 注入的声明必须带**可比下限**才构成完整关系（否则规则前提缺失，会判 NOT_APPLICABLE）：
  //   constraint-decl    → 10（满足 MAX_TOPICS = 8）
  //   constraint-violate → 6（不满足 → 必须 DRIFT）
  if (mutate === 'constraint-decl') out.numbers.minDeclaredTopics = 10
  if (mutate === 'constraint-violate') out.numbers.minDeclaredTopics = 6
  // 声明缺少 @constraintTarget → 标记无效
  if (mutate === 'constraint-badmark') {
    out.declarations = [...out.declarations, { file: 'INJECTED.ts', relation: 'gen-le-platform', target: null, rationale: null, valid: false }]
  }
  if (mutate === 'constraint-nodecl') {
    out.declarations = out.declarations.filter(d => d.target !== 'PLATFORM_CONTENT_LIMITS.*.topics')
    // 同时补一个平台上限值：C3 要验证的是「**数值配对存在、但关系未声明** → UNVERIFIED」。
    // xhs.topics 退役后真实表里已无该值，不注入就不存在候选关系，C3 会失去验证对象。
    out.numbers['PLATFORM_CONTENT_LIMITS.xhs.topics'] = 10
    out.numbers.minDeclaredTopics = 10
  }
  if (mutate === 'constraint-producer') out.fields['topic.maxTotalLength'] = { ...out.fields['topic.maxTotalLength'], producers: 1 }
  if (mutate === 'constraint-scan') throw new Error('EXTRACTION_FAILED: 注入的约束取证失败')
  return out
}

/**
 * 反例取证：调用 Python ast 扫描器，取回 uploader 类的**阻断证据**与**执行入口**。
 * 每次门禁运行时现扫，不读快照。扫描失败一律 EXTRACTION_FAILED。
 */
export function loadUploaderFacts({ mutate = null } = {}) {
  const OUT = join(HERE, '.uploaders.runtime.json')
  const r = spawnSync('python', [join(HERE, 'scan-uploaders.py'), OUT], { encoding: 'utf8', cwd: HERE })
  if (r.status !== 0) throw new Error('EXTRACTION_FAILED: uploader 扫描失败 ' + String(r.stderr || r.stdout || '').trim().slice(0, 120))
  if (!existsSync(OUT)) throw new Error('EXTRACTION_FAILED: 扫描器未产出结果')
  const data = JSON.parse(readFileSync(OUT, 'utf8'))
  try { rmSync(OUT, { force: true }) } catch {}

  // 动态调用：无法排除间接注册时必须 UNVERIFIED，不能当作"没有入口"
  const cliSrc = read('engine/social-auto-upload/sau_cli.py')
  const dynamic = ['importlib', '__import__', 'getattr(', 'globals()', 'eval('].filter(k => cliSrc.includes(k))
  // 各**产品平台**实际注册的内容类型（与 platform-catalog 同源：sau_cli.py action + CLI_PLATFORM_MAP）
  const cliSrc2 = read('engine/social-auto-upload/sau_cli.py')
  const cliActs = {}
  let curPlat = null
  for (const line of cliSrc2.split('\n')) {
    const m = /^\s*[\w]+\s*=\s*([\w.]+)\.add_parser\(\s*["']([\w-]+)["']/.exec(line)
    if (!m) continue
    const base = m[1] ?? '', name = m[2] ?? ''
    if (base === 'platform_parsers') { curPlat = name; cliActs[curPlat] = []; continue }
    const owner = /^(\w+)_actions$/.exec(base)?.[1]
    if (owner !== undefined && cliActs[owner] !== undefined && /^(upload|post|publish)/.test(name)) cliActs[owner].push(name)
  }
  const workerSrc = read('engine/worker.py')
  const mapBlock = /CLI_PLATFORM_MAP\s*=\s*\{([^}]*)\}/s.exec(workerSrc)?.[1] ?? ''
  const engineToCli = {}
  for (const m of mapBlock.matchAll(/"([\w]+)"\s*:\s*"([\w]+)"/g)) engineToCli[m[1] ?? ''] = m[2] ?? ''
  const cliActionsByPlatform = {}
  for (const [ek, cliName] of Object.entries(engineToCli)) {
    const acts = cliActs[cliName] ?? []
    const types = []
    if (acts.some(a => /video/i.test(a))) types.push('video')
    if (acts.some(a => /note|image/i.test(a))) types.push('image_text')
    cliActionsByPlatform[ek] = types
  }
  const rawActionsByEngineKey = {}
  for (const [ek, cliName] of Object.entries(engineToCli)) rawActionsByEngineKey[cliName] = cliActs[cliName] ?? []
  const out = { uploaders: data.uploaders, cli: data.cli, dynamicMarkers: dynamic, cliActionsByPlatform, engineToCli, rawActionsByEngineKey }

  if (mutate === 'counterexample') {
    // 注入一个"已声明平台的类存在阻断方法"的场景（用对照组做宿主，验证检测器能报）
    out.uploaders.douyin_uploader.classes.DouYinNote.blocked = [{ method: 'INJECTED_blocked', line: 1, raiseAt: [1] }]
  }
  if (mutate === 'counterexample-clear') {
    out.uploaders.tencent_uploader.classes.TencentNote.blocked = []
  }
  if (mutate === 'counterexample-dynamic') out.dynamicMarkers = ['importlib']
  // 人为把视频号**重新声明**为支持图文 —— 检测器必须再次发现实现阻断/入口缺失
  if (mutate === 'counterexample-redeclare') {
    out.cliActionsByPlatform = { ...out.cliActionsByPlatform, wxSph: ['video', 'image_text'] }
  }
  if (mutate === 'counterexample-scan') throw new Error('EXTRACTION_FAILED: 注入的 uploader 扫描失败')
  // 证据链场景：给已声明且有入口的平台注入实现阻断（模拟"action 存在但实现没做"）
  if (mutate === 'evidence-blocked') {
    const dy = out.uploaders?.douyin_uploader?.classes?.DouYinNote
    if (dy) dy.blocked = [{ method: 'INJECTED_note_upload', line: 1, raiseAt: [1] }]
  }
  // 证据链场景：人为只恢复 wxSph 的图文**声明**（不给 action）→ 入口缺失
  if (mutate === 'evidence-declare-only') out.__forceDeclared = { wxSph: ['video', 'image_text'] }
  // 证据链场景：同时恢复声明与 action → 实现阻断
  if (mutate === 'evidence-declare-and-action') {
    out.__forceDeclared = { wxSph: ['video', 'image_text'] }
    out.cliActionsByPlatform = { ...out.cliActionsByPlatform, wxSph: ['video', 'image_text'] }
    out.rawActionsByEngineKey = { ...out.rawActionsByEngineKey, tencent: ['upload-video', 'upload-note'] }
  }
  return out
}

export function loadSources({ mutate = null, contractPath = null } = {}) {
  const CATALOG = 'server/src/platform-catalog.ts'
  const WORKER = 'engine/worker.py'
  const PLATCFG = 'project/bosom-friend-web/src/app/config/platConfig.ts'
  const SYNC = 'server/src/platform-sync.ts'

  const cat = read(CATALOG), wrk = read(WORKER), cfg = read(PLATCFG), syn = read(SYNC)

  const keys = {}
  for (const m of cat.matchAll(/(\w+_uploader):\s*\{\s*platform:\s*'([^']+)',\s*engineKey:\s*'([^']+)',\s*name:\s*'([^']+)'\s*\}/g))
    keys[m[1]] = { platform: m[2], engineKey: m[3], name: m[4] }
  if (Object.keys(keys).length === 0) throw new Error('EXTRACTION_FAILED: PLATFORM_KEYS')

  const plannedBlock = /PLANNED_PLATFORMS[^=]*=\s*\[([\s\S]*?)\]\s*\n/s.exec(cat)
  const planned = plannedBlock
    ? [...plannedBlock[1].matchAll(/platform:\s*'([^']+)',\s*engineKey:\s*'([^']+)'/g)].map(m => ({ platform: m[1], engineKey: m[2] }))
    : []
  if (planned.length === 0) throw new Error('EXTRACTION_FAILED: PLANNED_PLATFORMS')

  const limits = {}
  for (const m of cat.matchAll(/(\w+):\s*\{\s*name:\s*'([^']+)'[^}]*\}/g)) limits[m[1]] = { name: m[2] }

  const enumBlock = /export enum PlatType \{([^}]*)\}/s.exec(cfg)
  if (!enumBlock) throw new Error('EXTRACTION_FAILED: PlatType')
  const platType = [...enumBlock[1].matchAll(/(\w+)\s*=\s*'([^']+)'/g)].map(m => m[2])
  if (platType.length === 0) throw new Error('EXTRACTION_FAILED: PlatType 空集')

  const cliMapBlock = /CLI_PLATFORM_MAP\s*=\s*\{([^}]*)\}/s.exec(wrk)
  if (!cliMapBlock) throw new Error('EXTRACTION_FAILED: CLI_PLATFORM_MAP')
  const cliMap = {}
  for (const m of cliMapBlock[1].matchAll(/"([\w]+)":\s*"([\w]+)"/g)) cliMap[m[1]] = m[2]
  if (Object.keys(cliMap).length === 0) throw new Error('EXTRACTION_FAILED: CLI_PLATFORM_MAP 空集')

  const mpBlock = /module_paths\s*=\s*\{([^}]*)\}/s.exec(wrk)
  const modulePaths = mpBlock ? [...mpBlock[1].matchAll(/"([\w]+)":/g)].map(m => m[1]) : []
  if (modulePaths.length === 0) throw new Error('EXTRACTION_FAILED: module_paths')

  // 嵌套大括号不要用 [^}]* 做块提取（会在第一个 } 截断，本轮踩过）——该模式全文唯一，直接全文扫。
  const canSyncPairs = [...syn.matchAll(/(\w+):\s*\{\s*name:\s*'[^']*',\s*canSync:\s*(true|false)\s*\}/g)]
  if (canSyncPairs.length === 0) throw new Error('EXTRACTION_FAILED: SYNC_ADAPTERS canSync 未命中')
  const canSync = canSyncPairs.filter(m => m[2] === 'true').map(m => m[1])

  let cliPlatforms = []
  if (contractPath !== null) {
    if (!existsSync(contractPath)) throw new Error('EXTRACTION_FAILED: 契约文件不存在 ' + contractPath)
    cliPlatforms = Object.keys(JSON.parse(readFileSync(contractPath, 'utf8')))
    if (cliPlatforms.length === 0) throw new Error('EXTRACTION_FAILED: 契约里没有平台')
  }

  const src = {
    productIdFrontend: platType,
    productIdChannel: extractStringArray(cat, 'PRODUCT_CHANNEL_PLATFORMS', CATALOG),
    enginePublish: extractStringArray(cat, 'ENGINE_PUBLISH_PLATFORMS', CATALOG),
    engineLogin: extractStringArray(cat, 'ENGINE_LOGIN_PLATFORMS', CATALOG),
    keys, planned, cliMap, modulePaths, canSync, cliPlatforms, limits,
    hasContract: contractPath !== null,
  }
  // 自证注入：只在内存里篡改，不写任何文件
  if (mutate === 'publish-platforms') src.enginePublish = [...src.enginePublish, 'nonexistent-platform']
  // 篡改「后端频道清单」一侧（规则比的是 前端 PlatType vs 后端频道清单），才能制造不一致
  if (mutate === 'platform-keys') src.productIdChannel = src.productIdChannel.filter(p => p !== 'weibo')
  if (mutate === 'display-name') src.limits = { ...src.limits, xhs: { name: '小红书（漂移版）' } }
  return src
}