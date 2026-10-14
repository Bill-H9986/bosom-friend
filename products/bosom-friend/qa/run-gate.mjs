#!/usr/bin/env node
/**
 * Bosom Friend 一键门禁（红绿灯报告）
 *
 * 只读检查：不修改任何源码、数据或产物；仅写入 qa/reports/ 下的门禁报告。
 *
 * 用法：
 *   node products/bosom-friend/qa/run-gate.mjs          # 快速门禁（静态边界 + 追溯一致性）
 *   node products/bosom-friend/qa/run-gate.mjs --full   # 追加 S 级前端验收（需应用可启动）
 *
 * 退出码：0 = 无红灯；1 = 存在红灯（禁止合并 / 发布）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const productRoot = resolve(scriptDir, '..')
const repoRoot = resolve(productRoot, '..', '..')
const full = process.argv.includes('--full')

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'])
const SKIP_DIRS = new Set(['node_modules', '.venv', '__pycache__', 'dist', 'build', 'lib', '.git', 'cookies', 'cookiesFile', 'media', 'videos', 'static', 'db', 'logs', '_exam_evidence', '_probe_shots'])

const checks = []

function add(name, status, detail, evidence = '') {
  checks.push({ name, status, detail, evidence })
}

/** 端点名两侧允许出现的定界符：路径分隔符、三种引号；右侧额外允许查询串起始符。 */
const ENDPOINT_DELIMITERS = ['/', "'", '"', String.fromCharCode(96)]
/** 右侧定界符（多一个 ?：`/agnesapi?video_id=` 这类把端点名接到查询串前）。 */
const ENDPOINT_DELIMITERS_AFTER = ['/', "'", '"', String.fromCharCode(96), '?']

/**
 * 端点名是否作为**完整的路径段或字符串字面量**出现。
 *
 * 为什么不能用 `line.includes(id)`：`videos` 同时是常见的属性名与类型字段名，
 * 裸子串会把 `videos: { maxCount: 1 }`、`videos: number` 这类纯声明判成厂商直连
 * （2026-09-22 实测：50 处命中里 45 处是这种假阳性，真正该报的 5 处全在 media-gateway.ts）。
 * 要求两侧是定界符后，只有 `'/videos/generations'`、`'/videos'` 这类端点形态才会命中。
 *
 * @param line - 单行源码。
 * @param id - 端点名（如 `videos`）。
 * @returns 该端点名是否以完整路径段/字面量形态出现。
 */
function endpointNameIsSegment(line, id) {
  let index = line.indexOf(id)
  while (index !== -1) {
    const before = index > 0 ? line[index - 1] : ''
    const after = line[index + id.length]
    const beforeOk = ENDPOINT_DELIMITERS.includes(before)
    const afterOk = after === undefined || ENDPOINT_DELIMITERS_AFTER.includes(after)
    if (beforeOk && afterOk) return true
    index = line.indexOf(id, index + 1)
  }
  return false
}

async function collectFiles(dir, matcher, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('vendor-kernel')) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) await collectFiles(p, matcher, out)
    else if (matcher(p, entry.name)) out.push(p)
  }
  return out
}

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

/** 工作区是否有未提交改动：报告必须标出来，否则一次绿灯会被当成「这版代码没问题」引用。 */
function gitDirty() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim() !== ''
}

// 检查 1：启动器只挂官方内核，禁止 DSH Web UI 与 dsh-client-*
// 旧 Web 入口 bin.ts 已被并行内核入口 bin-kernel.ts 取代（绞杀式迁移，bin.ts 可删除）。
// 故先看 bin.ts，缺失则回退核验 bin-kernel.ts（dsh-base + dsh-bosom-friend-kernel，无 Web UI）。
const legacyLauncher = join(productRoot, 'launcher', 'src', 'bin.ts')
const kernelLauncher = join(productRoot, 'launcher', 'src', 'bin-kernel.ts')
const launcherPath = existsSync(legacyLauncher) ? legacyLauncher : kernelLauncher
if (!existsSync(launcherPath)) {
  add('DSH 内核组合（启动器）', 'red', '找不到 launcher/src/bin.ts 或 bin-kernel.ts，无法核验。', launcherPath)
} else {
  const src = readFileSync(launcherPath, 'utf8')
  const hasBase = src.includes('@deepseek-ai/dsh-base')
  const hasWebUi = /@deepseek-ai\/dsh-web-app/.test(src)
  const hasClient = /@deepseek-ai\/dsh-client-[a-z-]+/.test(src)
  const hasKernel = /@deepseek-ai\/dsh-bosom-friend-(kernel|app)/.test(src)
  if (hasWebUi || hasClient) {
    add(
      'DSH 内核组合（启动器）',
      'red',
      `禁止挂载 DSH Web UI 或 dsh-client-*：dsh-web-app=${hasWebUi}，dsh-client-*=${hasClient}。应改为 dsh-base + dsh-bosom-friend-kernel。`,
      launcherPath,
    )
  } else if (!hasBase || !hasKernel) {
    add(
      'DSH 内核组合（启动器）',
      'red',
      `缺少官方内核挂载：dsh-base=${hasBase}，dsh-bosom-friend-kernel=${hasKernel}。`,
      launcherPath,
    )
  } else {
    add('DSH 内核组合（启动器）', 'green', 'dsh-base 已挂载，未发现 dsh-web-app / dsh-client-*。', launcherPath)
  }
}

// 检查 1b：并行内核入口（新路径）只挂官方内核，无 Web UI
const kernelEntryPath = join(productRoot, 'launcher', 'src', 'bin-kernel.ts')
if (!existsSync(kernelEntryPath)) {
  add('DSH 内核入口（并行新路径）', 'yellow', '并行内核入口尚未建立（launcher/src/bin-kernel.ts）。')
} else {
  const kernelSrc = readFileSync(kernelEntryPath, 'utf8')
  const bundleText = /const BUNDLES = \[([^\]]*)\]/.exec(kernelSrc)?.[1] ?? ''
  const hasBase = bundleText.includes('@deepseek-ai/dsh-base')
  const hasKernel = bundleText.includes('@deepseek-ai/dsh-bosom-friend-kernel')
  const hasWeb = /@deepseek-ai\/dsh-web-app|dsh-client-/.test(bundleText)
  if (hasWeb) {
    add('DSH 内核入口（并行新路径）', 'red', '内核入口出现 dsh-web-app / dsh-client-*，禁止。', kernelEntryPath)
  } else if (!hasBase || !hasKernel) {
    add('DSH 内核入口（并行新路径）', 'red', `内核组合不完整：dsh-base=${hasBase}，dsh-bosom-friend-kernel=${hasKernel}。`, kernelEntryPath)
  } else {
    add('DSH 内核入口（并行新路径）', 'green', '内核入口组合正确：dsh-base + dsh-bosom-friend-kernel，无 Web UI。', kernelEntryPath)
  }
}

// 检查 2：禁止直连模型接口
const sourceDirs = [
  'server/src',
  'launcher/src',
  'kernel/src',
  'shim',
  'project/bosom-friend-electron/electron',
  'project/bosom-friend-electron/src',
  'project/bosom-friend-harness/src',
  'project/bosom-friend-web/src',
  'bundle/app/src',
  // 产品服务端：文本走内核、图片/视频/配音此前直连厂商，一律纳入直连扫描（ADR-001「清零直连红灯」）。
  'server/src',
]
// 直连面：不再只盯 chat/completions。只查文本那一条时，图片/视频/配音三条直连永远是绿灯
// （2026-09-21 实测：内核只跑文本，图片/视频/配音共 8 处直连厂商 HTTP 却从未被门禁发现）。
const VENDOR_ENDPOINTS = [
  { id: 'chat/completions', label: '文本' },
  { id: 'images/generations', label: '图片' },
  { id: 'videos', label: '视频' },
  { id: 'audio/speech', label: '语音' },
]
// 已登记的过渡直连：每条必须写清"内核侧还缺什么能力"，收编一条删一条（这份清单只减不增）。
//
// **当前为空**（2026-09-23）：配音也进了能力面——设置页把用户自配的语音来源写成 `settings.yaml` 里
// `media-pi-ai` 的 `bf-voice` 路由（各家差异落在路由的 `speech` 方言里），产品服务端一处厂商 HTTP
// 都不剩。表与扫描规则留在原地：下一次新增直连必须显式登记，并被评审看见。
/** @type {{ suffix: string, id: string, reason: string }[]} */
const ALLOWED_DIRECT = []
const directHits = []
for (const d of sourceDirs) {
  const dir = join(productRoot, d)
  if (!existsSync(dir)) continue
  const files = await collectFiles(dir, (_p, name) => SOURCE_EXTS.has(extname(name).toLowerCase()))
  for (const f of files) {
    const rel = relative(repoRoot, f).replace(/\\/g, '/')
    const text = readFileSync(f, 'utf8')
    text.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      for (const endpoint of VENDOR_ENDPOINTS) {
        if (!endpointNameIsSegment(line, endpoint.id)) continue
        const allowed = ALLOWED_DIRECT.find(a => rel.endsWith(a.suffix) && a.id === endpoint.id)
        directHits.push({ where: `${rel}:${i + 1}`, endpoint, allowed })
      }
    })
  }
}
const unregistered = directHits.filter(hit => hit.allowed === undefined)
const registered = directHits.filter(hit => hit.allowed !== undefined)
if (unregistered.length > 0) {
  const shown = unregistered.slice(0, 30)
    .map(hit => `${hit.where}  [${hit.endpoint.label} ${hit.endpoint.id}]`)
    .join('\n')
  add('禁止直连模型接口', 'red',
    `发现 ${unregistered.length} 处未登记的厂商直连：${[...new Set(unregistered.map(h => h.endpoint.label))].join('/')}接口必须经官方 DSH 内核，或登记进 ALLOWED_DIRECT 并写明内核侧缺什么能力。`,
    shown)
} else if (registered.length > 0) {
  add('禁止直连模型接口', 'yellow',
    `仍有 ${registered.length} 处已登记的过渡直连：登记不等于可以留着，内核侧补齐所缺能力后必须收编：`,
    ALLOWED_DIRECT.map(a => `${a.suffix} [${a.id}] —— ${a.reason}`).join('\n'))
} else {
  add('禁止直连模型接口', 'green', '所有模型调用（文本/图片/视频/语音）都经官方 DSH 内核。')
}

// 检查 3：依赖中禁止 dsh-web / dsh-client 系列
const pkgFiles = await collectFiles(productRoot, (_p, name) => name === 'package.json')
const badDeps = []
for (const f of pkgFiles) {
  // legacy-archive 为已归档豁免目录，不计入门禁依赖边界
  if (f.includes('legacy-archive')) continue
  try {
    const json = JSON.parse(readFileSync(f, 'utf8'))
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const key of Object.keys(json[section] || {})) {
        if (/@deepseek-ai\/dsh-web-app|@deepseek-ai\/dsh-client-ui/.test(key)) badDeps.push(`${relative(repoRoot, f)}: ${key}`)
      }
    }
  } catch {
    // 非 JSON 或读取失败，跳过（记录文件本身不构成门禁依据）
  }
}
if (badDeps.length > 0) {
  add('依赖边界（禁 DSH Web UI 包）', 'red', `发现 ${badDeps.length} 个禁止依赖。`, badDeps.slice(0, 30).join('\n'))
} else {
  add('依赖边界（禁 DSH Web UI 包）', 'green', '未发现 dsh-web-app / dsh-client-ui 系列依赖。')
}

// 检查 4：功能完整性（未实现 AC 清零）+ 验收准则覆盖率 + 缺陷闭环留痕
const rtmPath = join(productRoot, 'docs', 'trace', 'RTM.md')
if (!existsSync(rtmPath)) {
  add('功能完整性（未实现清零）', 'red', '缺少 docs/trace/RTM.md。', rtmPath)
  add('验收准则覆盖率', 'red', '缺少 docs/trace/RTM.md。', rtmPath)
} else {
  const rtmText = readFileSync(rtmPath, 'utf8')
  const acRows = rtmText.split(/\r?\n/).filter((l) => /^\s*\|\s*AC-\d+/.test(l))
  const known = new Set(['已覆盖', '部分', '未覆盖', '未实现'])
  const notImpl = []
  const malformed = []
  const gaps = []
  let covered = 0
  let partial = 0
  for (const row of acRows) {
    const cells = row.split('|').map((s) => s.trim()).slice(1, -1)
    const [id, req, _crit, status] = cells
    if (!req || ['—', '-'].includes(req)) malformed.push(`${id}: 缺关联 REQ`)
    if (!known.has(status)) malformed.push(`${id}: 状态不合法（${status || '空'}）`)
    if (status === '未实现') notImpl.push(`${id}（${req || '未标 REQ'}）`)
    else if (status === '已覆盖') covered += 1
    else if (status === '部分') partial += 1
    else if (status === '未覆盖') gaps.push(id)
  }
  if (malformed.length > 0) {
    add('追溯结构完整性', 'red', `${malformed.length} 行登记不合规。`, malformed.slice(0, 30).join('\n'))
  } else {
    add('追溯结构完整性', 'green', '所有已登记 AC 行结构合规。')
  }
  if (notImpl.length > 0) {
    add('功能完整性（未实现清零）', 'red', `${notImpl.length} 条功能未实现，UAT/发布前必须清零。`, notImpl.join('\n'))
  } else {
    add('功能完整性（未实现清零）', 'green', '无未实现功能。')
  }
  if (acRows.length === 0) {
    add('验收准则覆盖率', 'yellow', '功能盘点尚未完成（0 条 AC）。历史功能待 Phase 1 起登记。')
  } else {
    const pct = ((covered + partial * 0.5) / acRows.length) * 100
    const gapText = gaps.length > 0 ? `；未覆盖：${gaps.slice(0, 10).join('、')}` : ''
    if (pct < 100) {
      add('验收准则覆盖率', 'yellow', `覆盖率 ${pct.toFixed(1)}%（覆盖 ${covered} / 部分 ${partial} / 总数 ${acRows.length}），发布前必须 100%${gapText}。`)
    } else {
      add('验收准则覆盖率', 'green', `覆盖率 100%（${acRows.length} 条 AC）。`)
    }
  }
}
const defPath = join(productRoot, 'qa', 'defects', '缺陷台账.md')
const defIssues = []
let defRows = 0
if (existsSync(defPath)) {
  const defText = readFileSync(defPath, 'utf8')
  for (const row of defText.split(/\r?\n/).filter((l) => /^\s*\|\s*DEF-\d+/.test(l))) {
    defRows += 1
    const cells = row.split('|').map((s) => s.trim()).slice(1, -1)
    const [id, _title, _sev, status, _type, root, req, regression] = cells
    if (!['Fixed', 'Verified', 'Closed'].includes(status)) continue
    if (!root || ['—', '-'].includes(root)) defIssues.push(`${id}: 关闭前缺根因归类`)
    if (!req || ['—', '-'].includes(req)) defIssues.push(`${id}: 缺关联 REQ`)
    if (!regression || ['—', '-'].includes(regression)) defIssues.push(`${id}: 关闭前缺回归用例`)
  }
} else {
  add('缺陷闭环留痕', 'red', '缺少 qa/defects/缺陷台账.md，缺陷闭环无从校验。')
}
if (defIssues.length > 0) {
  add('缺陷闭环留痕', 'red', `${defIssues.length} 处缺口。`, defIssues.slice(0, 30).join('\n'))
} else if (defRows === 0) {
  // 空台账不等于合规：曾长期是「（暂无）」，门禁因此空过（没有 DEF 行就没有可校验字段）。
  add('缺陷闭环留痕', 'yellow', '台账里没有已登记缺陷：门禁无法据此判定，请把已修缺陷补登。')
} else {
  add('缺陷闭环留痕', 'green', `已登记缺陷 ${defRows} 条，关闭字段合规。`)
}

// 检查 4b：持久化数据编码完整性（专用门禁存在但长期未接入本门禁 → 曾让"0 红灯"掩盖 10 处损坏）
const integrityGate = join(productRoot, 'qa', 'check-data-integrity.mjs')
if (!existsSync(integrityGate)) {
  add('数据编码完整性', 'yellow', '缺少 qa/check-data-integrity.mjs，无法检查落盘数据编码。')
} else {
  const res = spawnSync(process.execPath, [integrityGate], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim()
  const tail = out.split(/\r?\n/).slice(-6).join('\n')
  if (res.status === 0) add('数据编码完整性', 'green', '落盘数据无编码损坏。', tail)
  else add('数据编码完整性', 'red', `编码损坏未修复（退出码 ${res.status}）。`, tail)
}

// 检查 5：安装包只读保护（回滚安全网不得被改动）
const checksumsPath = join(scriptDir, 'baseline', 'installer-checksums.json')
if (!existsSync(checksumsPath)) {
  add('安装包只读保护', 'yellow', '尚无安装包保护基线（qa/baseline/installer-checksums.json 缺失）。')
} else {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(checksumsPath, 'utf8'))
  } catch {
    add('安装包只读保护', 'red', '保护基线文件损坏，无法解析。', checksumsPath)
    manifest = undefined
  }
  if (manifest !== undefined) {
    // 存放目录由基线声明（2026-09-14 起指向仓库外的固定回滚库）：仓库会被整理清理，
    // 安全网放在仓库里已经丢过一次（5 个回滚包 + 0.2.41 全没了）。目录不在位判黄（外置盘没接？），
    // 目录在但文件缺失/哈希不一致才判红。
    const storeDir = typeof manifest.dir === 'string' && manifest.dir !== '' ? manifest.dir : join(repoRoot, 'release')
    const violations = []
    if (!existsSync(storeDir)) {
      add('安装包只读保护', 'yellow', `回滚包存放目录不在位：${storeDir}（外置盘未接入，或目录被移动）。接入后重跑本检查。`, storeDir)
    } else {
    for (const file of manifest.files ?? []) {
      const target = join(storeDir, file.name)
      if (!existsSync(target)) {
        violations.push(`${file.name}: 文件缺失或被移动`)
        continue
      }
      const actual = await new Promise((resolveHash, reject) => {
        const hash = createHash('sha256')
        createReadStream(target)
          .on('error', reject)
          .on('data', (chunk) => hash.update(chunk))
          .on('end', () => resolveHash(hash.digest('hex').toUpperCase()))
      })
      if (actual !== file.sha256) violations.push(`${file.name}: 哈希不一致（可能被覆盖或修改）`)
    }
    if (violations.length > 0) {
      add('安装包只读保护', 'red', `${violations.length} 个回滚安装包异常。`, violations.join('\n'))
    } else {
      add('安装包只读保护', 'green', `${(manifest.files ?? []).length} 个回滚安装包与基线一致（存放目录 ${storeDir}）。`)
    }
    }
  }
}

// 检查 4c：AI 智能体任务动作（C2-03 中断/继续 + C2-04 分享链接）
// **必须排在「模型配置链路」之前**：那条检查会把用户的对话提供方临时换成占位密钥的测试提供方
// （再恢复），夹在中间跑这一项时，服务端在那一刻取到的对话模型是占位密钥——
// 表现就是这里判"模型不可用"黄灯（实测 2026-09-20 连续三轮都撞上）。顺序换过来即可，判据不动。
const agentGate = join(productRoot, 'qa', 'verify-agent-task-actions.mjs')
if (!existsSync(agentGate)) {
  add('AI 智能体任务动作', 'red', '缺少 verify-agent-task-actions.mjs。', agentGate)
} else {
  const res = spawnSync(process.execPath, [agentGate], {
    cwd: repoRoot,
    encoding: 'utf8',
    // 这一项要真实调用对话模型（中断/继续各一次），机器被 E2E 占满时会明显变慢。
    timeout: 8 * 60 * 1000,
    env: { ...process.env, BF_QA_ORIGIN: process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280' },
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-10).join('\n')
  const summary = out.split(/\r?\n/).find((l) => l.startsWith('AGENT_TASK_ACTIONS ')) ?? ''
  if (res.status === 0) add('AI 智能体任务动作', 'green', '中断真的停、继续能接上、分享有效期与只读页全部通过。', summary || tail)
  else if (res.status === 3) add('AI 智能体任务动作', 'green', '分享链路全部通过；中断语义这一轮没验到——模型会答但一次吐完整段正文，没有可中断的增量窗口（属于厂商流式行为，不是产品缺陷，判据未放宽）。', summary || tail)
  else if (res.status === 2) add('AI 智能体任务动作', 'yellow', '开发版未运行或模型不可用，无法执行中断/分享检查。', tail)
  else add('AI 智能体任务动作', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}。`, tail)
}

// 检查 5：模型配置端到端链路（保存 → 落盘 → DSH 设置/凭据 → 内核注册路由）
// 这条链跨四个环节，任何一环断开的表现都是"保存了但 AI 没反应"，必须真实跑。
const llmGate = join(productRoot, 'qa', 'verify-llm-config.mjs')
if (!existsSync(llmGate)) {
  add('模型配置链路', 'red', '缺少 verify-llm-config.mjs。', llmGate)
} else {
  const res = spawnSync(process.execPath, [llmGate], {
    cwd: repoRoot,
    encoding: 'utf8',
    // 这条链最后一步要起一个内核做 initialize 握手；机器被 E2E 占满时实测会拖过 5 分钟，
    // 表现成"退出码 1 + 正常输出"，看着像产品坏了。预算提到 10 分钟，并把超时单独报出来。
    timeout: 10 * 60 * 1000,
    env: { ...process.env, BF_QA_ORIGIN: process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280' },
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const tail = out.split(/\r?\n/).slice(-14).join('\n')
  if (res.status === 0) add('模型配置链路', 'green', '保存→落盘→DSH 设置→内核路由 全部通过。', tail)
  else if (res.signal !== null || res.status === null) add('模型配置链路', 'red', '超时被打断（10 分钟预算用尽）：这一项要单独留时间。', tail)
  else if (out.includes('fetch failed') || out.includes('ECONNREFUSED')) add('模型配置链路', 'yellow', '开发版未运行，无法执行端到端检查。', tail)
  else add('模型配置链路', 'red', `退出码 ${res.status}。`, tail)
}

// 检查 5b：业务域 CRUD 四步矩阵（铁律 #9 第 2/6 条：每域四步在前端走通且可执行）
// 应用未运行时判黄灯（开发中正常），失败即红灯（禁止合并 / 发布）。
const crudGate = join(productRoot, 'qa', 'crud-matrix.mjs')
if (!existsSync(crudGate)) {
  add('业务域 CRUD 四步', 'red', '缺少 crud-matrix.mjs。', crudGate)
} else {
  const res = spawnSync(process.execPath, [crudGate], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    env: { ...process.env, BF_QA_ORIGIN: process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280' },
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-10).join('\n')
  const summary = out.split(/\r?\n/).find((l) => l.startsWith('CRUD_MATRIX ')) ?? ''
  if (res.status === 0) add('业务域 CRUD 四步', 'green', '五个业务域增/查/改/删 + 落盘 + 空态全部通过。', summary || tail)
  else if (res.status === 2) add('业务域 CRUD 四步', 'yellow', '开发版未运行，无法执行四步检查。', tail)
  else add('业务域 CRUD 四步', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}。`, tail)
}

// 检查 5c：知识库蒸馏链路（铁律 #14：检索 → 注入 → 蒸馏 → 导出）
const distillGate = join(productRoot, 'qa', 'knowledge-distill.mjs')
if (!existsSync(distillGate)) {
  add('知识库蒸馏链路', 'red', '缺少 knowledge-distill.mjs。', distillGate)
} else {
  const res = spawnSync(process.execPath, [distillGate], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    env: { ...process.env, BF_QA_ORIGIN: process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280' },
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-10).join('\n')
  const summary = out.split(/\r?\n/).find((l) => l.startsWith('KNOWLEDGE_DISTILL ')) ?? ''
  if (res.status === 0) add('知识库蒸馏链路', 'green', '检索命中、注入留痕、蒸馏样本、JSONL 导出全部通过。', summary || tail)
  else if (res.status === 2) add('知识库蒸馏链路', 'yellow', '开发版未运行，无法执行蒸馏链路检查。', tail)
  else add('知识库蒸馏链路', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}。`, tail)
}

// 检查 5j：服务端功能测试（vitest，进程内驱动真实路由表：契约/状态机/落盘副作用）
const functionalDir = join(productRoot, 'server')
if (!existsSync(join(functionalDir, 'vitest.config.ts'))) {
  add('服务端功能测试', 'red', '缺少 server/vitest.config.ts。', functionalDir)
} else {
  // 预算按**单独跑的实测**给：全量 251 条实测 288 秒（长视频那 58 条自己就 5 分钟），
  // 原先的 5 分钟只差 12 秒就撞线——门禁里与 E2E 等检查并行时必被 kill，
  // 表现成"退出码 null + 一堆正常 stderr"，看着像用例失败，其实是被超时打断（实测 2026-09-20）。
  const res = spawnSync('npx', ['vitest', 'run', '--config', 'server/vitest.config.ts'], {
    cwd: productRoot,
    encoding: 'utf8',
    shell: true,
    timeout: 12 * 60 * 1000,
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find((l) => /Tests\s+.*(passed|failed)/.test(l)) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
  if (res.status === 0) add('服务端功能测试', 'green', '路由契约、统计口径、批量删除语义、上传票据、路由表不变量全部通过（进程内，秒级）。', summary || tail)
  else if (res.signal !== null || res.status === null) add('服务端功能测试', 'red', '超时被打断（12 分钟预算用尽）：这一项要单独留时间，不能与其他重检查并行。', summary || tail)
  else add('服务端功能测试', 'red', `退出码 ${res.status}：${summary || '存在失败用例'}。`, tail)
}

// 检查 5k2：前端单元测试必须**收集得起来**（DEF-069）
// 为什么单独钉"收集"这一条：裸相对路径指向改名前的目录时，套件级 FAIL 与"这个文件没有测试"
// 在输出里长得很像，而失败与"跑不起来"是两件事——先把底线钉住，再谈断言质量。
const frontendDir = join(productRoot, 'project', 'bosom-friend-electron')
if (!existsSync(join(frontendDir, 'vite.config.mts'))) {
  add('前端单元测试', 'yellow', '缺少 project/bosom-friend-electron（前端源码未随本工作区部署）。', frontendDir)
} else {
  const res = spawnSync('npx', ['vitest', 'run'], {
    cwd: frontendDir,
    encoding: 'utf8',
    shell: true,
    timeout: 5 * 60 * 1000,
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const failedSuites = (out.match(/Failed Suites/g) || []).length
  const summary = out.split(/\r?\n/).find((l) => /Tests\s+.*(passed|failed)/.test(l)) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
  if (failedSuites > 0)
    add('前端单元测试', 'red', `${failedSuites} 个套件**收集失败**（多半是 import 指向已改名/已删除的路径，见 DEF-069）。`, tail)
  else if (res.status === 0)
    add('前端单元测试', 'green', '前端单测全部通过，且每个套件都收集得起来。', summary || tail)
  else
    add('前端单元测试', 'red', `退出码 ${res.status}：${summary || '存在失败用例'}。`, tail)
}

// 检查 5k3：界面文案的键与占位符（用户看到 `已选 {count} / {total}` 这种半成品就是这里漏掉的）
// 为什么必须进主门禁：这两个脚本原先存在但**没有任何调用方**（写了没人跑等于没写）。
// 判据不依赖界面截图：键存在性、占位符写法、跨语言取值集合三条都能静态判红。
const i18nGate = join(productRoot, 'qa', 'verify-i18n-keys.mjs')
if (!existsSync(i18nGate)) {
  add('界面文案完整性', 'red', '缺少 qa/verify-i18n-keys.mjs（键与占位符无人校验）。', i18nGate)
} else {
  const res = spawnSync(process.execPath, [i18nGate], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find((l) => l.startsWith('I18N_KEYS ')) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
  if (res.status === 0) add('界面文案完整性', 'green', '关键键齐备；占位符写法与跨语言取值集合一致。', summary)
  else add('界面文案完整性', 'red', `退出码 ${res.status}：键缺失或占位符不会被替换。`, tail)
}

// 检查 5i：cordis 补丁一致性（dev/web 层与桌面层挂同一个插件时，id 与共享配置必须一致）
const cordisGate = join(productRoot, 'qa', 'verify-cordis-patches.mjs')
if (!existsSync(cordisGate)) {
  add('cordis 补丁一致性', 'red', '缺少 verify-cordis-patches.mjs。', cordisGate)
} else {
  const res = spawnSync(process.execPath, [cordisGate], { cwd: repoRoot, encoding: 'utf8', timeout: 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
  const summary = out.split(/\r?\n/).find((l) => l.startsWith('CORDIS_PATCHES ')) ?? ''
  if (res.status === 0) add('cordis 补丁一致性', 'green', '两层补丁挂同一插件时 id 与共享配置一致（只有桌面独有的键可不同）。', summary || tail)
  else add('cordis 补丁一致性', 'red', `退出码 ${res.status}：${summary || '存在漂移'}。`, tail)
}

// 检查 5l：启动页进度条（两种真实场景：接入既有服务走完全程 / 内核不回应给出可读原因）
// 进度条最容易写成"好看的假进度"：这条检查同时钉住单调不减与不确定态不推进两个语义。
const splashGate = join(productRoot, 'qa', 'probes', 'verify-splash-progress.mjs')
if (!existsSync(splashGate)) {
  add('启动页进度条', 'red', '缺少 qa/probes/verify-splash-progress.mjs。', splashGate)
} else {
  const res = spawnSync(process.execPath, [splashGate, '--both'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(l => l.startsWith('SPLASH_PROGRESS ')) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
  if (res.status === 0) add('启动页进度条', 'green', '进度语义（单调不减 / 不确定态不推进 / 阶段推进）与失败可读原因全部通过。', summary || tail)
  else if (res.status === 2) add('启动页进度条', 'yellow', '环境不满足（缺 electron 或产品服务起不来），无法执行启动页验收。', tail)
  else add('启动页进度条', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}。`, tail)
}

// 检查 5m：性能档位判定（判错是双向代价：好机器被降载 / 低配机器没降载）
const perfGate = join(productRoot, 'qa', 'probes', 'verify-perf-profile.mjs')
if (!existsSync(perfGate)) {
  add('性能档位判定', 'red', '缺少 qa/probes/verify-perf-profile.mjs。', perfGate)
} else {
  const res = spawnSync(process.execPath, [perfGate], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(l => l.startsWith('PERF_PROFILE ')) ?? ''
  if (res.status === 0) add('性能档位判定', 'green', '判定边界、上限夹取、环境透传与落盘留痕全部通过。', summary)
  else add('性能档位判定', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}`, out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n'))
}

// 检查 5n：内核握手超时（子进程活着但不回应时，等待必须有界）
const handshakeGate = join(productRoot, 'qa', 'probes', 'verify-kernel-handshake-timeout.mjs')
if (!existsSync(handshakeGate)) {
  add('内核握手超时', 'red', '缺少 qa/probes/verify-kernel-handshake-timeout.mjs。', handshakeGate)
} else {
  const res = spawnSync(process.execPath, [handshakeGate], { cwd: repoRoot, encoding: 'utf8', timeout: 3 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(l => l.startsWith('KERNEL_HANDSHAKE ')) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
  if (res.status === 0) add('内核握手超时', 'green', '内核不回应时按预算如实报错，不再无限等待。', summary)
  else if (res.status === 2) add('内核握手超时', 'yellow', '缺少内核入口产物，无法执行握手超时验收。', tail)
  else add('内核握手超时', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}`, tail)
}

// 检查 5n2：内核 bundle 新鲜度（构建是否真的吃到了当前源码）
// 现场 2026-09-21：pnpm 以硬链接注入工作区包，编辑器重写文件会换 inode 断链，pnpm install 认为
// 长度/时间戳已新而不修复；kernel 又是从 server 的 src 直接打包，于是产物里编进 6 天前的旧 store，
// 且没有任何构建步骤报错。判黄不判红：开发中途改了 src 尚未重建属正常，发布前必须处理。
const freshnessGate = join(productRoot, 'desktop', 'verify-kernel-bundle-freshness.mjs')
if (!existsSync(freshnessGate)) {
  add('内核 bundle 新鲜度', 'red', '缺少 desktop/verify-kernel-bundle-freshness.mjs。', freshnessGate)
} else {
  const res = spawnSync(process.execPath, [freshnessGate], { cwd: repoRoot, encoding: 'utf8', timeout: 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(l => l.startsWith('KERNEL_BUNDLE ')) ?? ''
  const stale = out.split(/\r?\n/).filter(l => l.trim().startsWith('STALE ')).slice(0, 6).join('\n')
  if (res.status === 0) add('内核 bundle 新鲜度', 'green', '内核产物不早于其全部源文件。', summary)
  else add('内核 bundle 新鲜度', 'yellow', '内核产物早于源文件：构建吃到了陈旧输入（先 pnpm install 再重建）。', summary + '\n' + stale)
}

// 检查 5o：内核运行时兜底解压（工具阶梯 + 失败文案 + 真进程正负对照）
// 现场 DEF-045：应用装完打不开，屏幕上只有一句 `spawn tar.exe ENOENT`——同一句话对应三种原因，
// 所以这里把"选谁解压、失败说什么"钉死，并断言主进程与安装器同阶梯。
const extractGate = join(productRoot, 'qa', 'probes', 'verify-kernel-extract.mjs')
if (!existsSync(extractGate)) {
  add('内核运行时兜底解压', 'red', '缺少 qa/probes/verify-kernel-extract.mjs。', extractGate)
} else {
  const res = spawnSync(process.execPath, [extractGate], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(l => l.startsWith('KERNEL_EXTRACT ')) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
  if (res.status === 0) add('内核运行时兜底解压', 'green', '工具阶梯、失败文案与真实解压（含 ENOENT 负向对照）全部通过。', summary)
  else add('内核运行时兜底解压', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}`, tail)
}

// 检查 5p：运行可诊断性（运行日志 + 内核自愈 + 前端诚实提示）
// 现场 DEF-083：界面一直弹"网络连接失败"、卡片生成失败，但产品既不写运行日志、内核死后
// 也没有检测与恢复入口、前端还把三种不同原因混成一句话——同一故障只能靠猜。三者缺一即红灯。
const diagGate = join(productRoot, 'qa', 'verify-runtime-diagnostics.mjs')
if (!existsSync(diagGate)) {
  add('运行可诊断性', 'red', '缺少 qa/verify-runtime-diagnostics.mjs。', diagGate)
} else {
  const res = spawnSync(process.execPath, [diagGate], { cwd: repoRoot, encoding: 'utf8', timeout: 3 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(l => l.startsWith('RUNTIME_DIAG ')) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
  if (res.status === 0) add('运行可诊断性', 'green', '运行日志落盘、内核掉线自愈与前端失败分类全部在线。', summary)
  else add('运行可诊断性', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}`, tail)
}

// 检查 5r：日志模块必须进包（DEF-101 的根因：没有任何检查项看着这件事）
const loggingGate = join(productRoot, 'desktop', 'verify-electron-logging.mjs')
if (!existsSync(loggingGate)) {
  add('日志模块进包', 'red', '缺少 desktop/verify-electron-logging.mjs。', loggingGate)
} else {
  const res = spawnSync(process.execPath, [loggingGate], { cwd: repoRoot, encoding: 'utf8', timeout: 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(l => l.startsWith('ELECTRON_LOGGING ')) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
  if (res.status === 0) add('日志模块进包', 'green', 'run-log 模块存在、已接线，且打包规则覆盖 electron/**。', summary)
  else add('日志模块进包', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}`, tail)
}

// 检查 5q：生成任务停滞兜底 + 内核运行日志（stderr 落盘）
// 现场 DEF-083 的另一半：服务活着、任务停滞时记录会永远停在 generating（实测 38 分钟），
// 界面一直转圈、已生成文案拿不到；同时内核 stderr（厂商 429/超时）此前没有任何文件出口。
// 两个脚本的产物依赖 server 构建：产物缺失判黄（环境未就绪），产物在但断言失败判红。
for (const [label, script, summaryPrefix] of [
  ['生成任务停滞兜底', join(productRoot, 'qa', 'verify-generation-watchdog.mjs'), 'GENERATION_WATCHDOG '],
  ['内核运行日志', join(productRoot, 'qa', 'verify-kernel-runtime-log.mjs'), 'KERNEL_RUNTIME_LOG '],
]) {
  if (!existsSync(script)) {
    add(label, 'red', '缺少 ' + script, script)
    continue
  }
  const res = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(l => l.startsWith(summaryPrefix)) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
  if (res.status === 0) add(label, 'green', '停滞判定边界、文案保留与 stderr 落盘全部通过。', summary)
  else if (res.status === 2) add(label, 'yellow', '缺少 server 构建产物，无法执行验收。', tail)
  else add(label, 'red', `退出码 ${res.status}：${summary || '存在失败断言'}`, tail)
}

// 检查 5s：视频时长规划与多片段拼接（官方 4~12 单次上限 → 30/60 秒必须多片拼接）
// 现场教训：规划/拼接错了在界面上看不出来（有画面有声音、长度就是不对），必须离线逐条验收。
for (const [label, script, summaryPrefix] of [
  ['视频时长规划', join(productRoot, 'qa', 'verify-video-duration.mjs'), 'VIDEO_DURATION '],
  ['多片段拼接与时长收敛', join(productRoot, 'qa', 'verify-video-compose.mjs'), 'VIDEO_COMPOSE '],
  ['视频档位接线', join(productRoot, 'qa', 'verify-video-duration-wiring.mjs'), 'VIDEO_GEARS_WIRING '],
]) {
  if (!existsSync(script)) {
    add(label, 'red', '缺少 ' + script, script)
    continue
  }
  const res = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8', timeout: 10 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(l => l.startsWith(summaryPrefix)) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
  if (res.status === 0) add(label, 'green', '档位规划、拼接与成片时长收敛全部通过（真 ffmpeg 跑过）。', summary)
  else if (res.status === 2) add(label, 'yellow', '缺少构建产物或随包 ffmpeg，无法执行验收。', tail)
  else add(label, 'red', `退出码 ${res.status}：${summary || '存在失败断言'}`, tail)
}

// 检查 5k：抖音真实播放量采集（列表接口的 play_count 是 0 占位，真值只在投稿分析接口）
const douyinGate = join(productRoot, 'qa', 'verify-douyin-play-count.py')
const enginePython = join(productRoot, 'engine', '.venv', 'Scripts', 'python.exe')
if (!existsSync(douyinGate)) {
  add('抖音真实播放量采集', 'red', '缺少 verify-douyin-play-count.py。', douyinGate)
} else if (!existsSync(enginePython)) {
  add('抖音真实播放量采集', 'yellow', '引擎 Python 环境不存在，无法校验播放量解析。', enginePython)
} else {
  const res = spawnSync(enginePython, [douyinGate], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find((l) => l.startsWith('抖音真实播放量验收：')) ?? ''
  if (res.status === 0) add('抖音真实播放量采集', 'green', '投稿分析接口的解析、占位 0 与 19 位 id 精度全部锁死。', summary)
  else add('抖音真实播放量采集', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}`, out.split(/\r?\n/).filter(Boolean).slice(-6).join('\n'))
}

// 检查 5j：内核业务工具真跑一遍（写错数据集合名只有真被调用才炸，静态检查抓不到）
//
// 颜色语义（2026-09-14 修订）：产物"不存在"是环境未就绪 → 黄；产物在、但工具跑不起来 → 红。
// 原来产物缺失直接判红，于是任何人 clean 一次工作区（dist/lib 都是可清理产物）门禁就满屏红，
// 几次之后红灯就没人看了；而同一份工作区里「内核握手超时」遇到"缺少内核入口产物"判的是黄——
// 同一个原因两种颜色本身就是缺陷（DEF-047）。
const KERNEL_BUILD_HINT = 'pnpm --filter @deepseek-ai/dsh-bosom-friend-server --filter @deepseek-ai/dsh-bosom-friend-kernel build'
const kernelToolsGate = join(productRoot, 'qa', 'verify-kernel-tools.mjs')
if (!existsSync(kernelToolsGate)) {
  add('内核工具可执行', 'red', '缺少 verify-kernel-tools.mjs。', kernelToolsGate)
} else {
  /** 被验产物：仓库构建产物 + 装机运行时（后者就是客户机器上真跑的那份，存在就一并验）。 */
  const targets = [{ label: '仓库构建产物', lib: join(productRoot, 'kernel', 'lib', 'index.js') }]
  const packaged = join(process.env.APPDATA ?? '', 'Bosom Friend', 'kernel-runtime', 'node_modules', '@deepseek-ai', 'dsh-bosom-friend-kernel', 'lib', 'index.js')
  if (process.env.APPDATA && existsSync(packaged)) targets.push({ label: '装机运行时', lib: packaged })
  const failures = []
  const passed = []
  const notReady = []
  for (const target of targets) {
    if (!existsSync(target.lib)) {
      notReady.push(target.label + '：产物不存在')
      continue
    }
    const res = spawnSync(process.execPath, [kernelToolsGate], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      env: { ...process.env, BF_KERNEL_LIB: target.lib },
    })
    const out = `${res.stdout || ''}${res.stderr || ''}`
    const summary = out.split(/\r?\n/).find((l) => l.startsWith('内核工具验收：')) ?? ''
    if (res.status === 0) passed.push(target.label + ' ' + summary)
    else failures.push(target.label + '：退出码 ' + res.status + '；' + (summary || out.split(/\r?\n/).filter(Boolean).slice(-3).join(' ')))
  }
  if (failures.length > 0) {
    add('内核工具可执行', 'red', '有工具跑不起来（注册正常但 execute 抛错，模型一调就是崩溃）：' + failures.join('；'), failures.join('\n'))
  } else if (passed.length === 0) {
    add('内核工具可执行', 'yellow', '产物未就绪，无法验收（先构建内核包：' + KERNEL_BUILD_HINT + '）。' + notReady.join('；'), notReady.join('\n'))
  } else if (notReady.length > 0) {
    add('内核工具可执行', 'yellow', '仓库构建产物不存在（先跑 ' + KERNEL_BUILD_HINT + '），本轮只验了装机运行时：' + passed.join('；'), notReady.join('\n') + '\n' + passed.join('\n'))
  } else {
    add('内核工具可执行', 'green', '内核业务工具全部真跑一遍：注册齐全、execute 不抛错、render 出文本，写回类工具的结果真的落盘。' + passed.join('；'), passed.join('\n'))
  }
}

// 检查 5j2：模型实际拿到的**工具清单**（读真实模型请求体）
//
// 为什么需要它：工具面收敛（把 pwsh / 文件读写 / subagent 这类编码智能体工具拿掉）
// 当初只靠一次人工看请求体验证过，**没有任何可重复的门禁**——它挡的是「模型在客户的 Windows 上
// 执行命令」，却没有任何东西在下次有人改补丁层时判红。
// 同一支探针顺带验纯文本会话**一个工具都不挂**（DEF-155 的预防层）。
//
// 颜色语义与 5j 一致：产物不在 = 环境未就绪（黄）；探针跑得起来但断言不过 = 回归（红）。
const effectiveToolsProbe = join(productRoot, 'qa', 'probes', 'probe-effective-tools.mjs')
const kernelEntry = join(productRoot, 'bundle', 'kernel', 'runtime', 'bin-kernel.mjs')
if (!existsSync(effectiveToolsProbe)) {
  add('有效工具面', 'red', '缺少 probe-effective-tools.mjs。', effectiveToolsProbe)
} else if (!existsSync(kernelEntry)) {
  add('有效工具面', 'yellow', '内核运行时不在这台机器上（探针起不了内核，本轮跳过）。', kernelEntry)
} else {
  /** 跑一次探针；返回退出码与输出。 */
  const runProbe = env => spawnSync(process.execPath, ['--import', 'tsx/esm', effectiveToolsProbe], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    env: { ...process.env, ...env },
  })
  const normal = runProbe({})
  const normalOut = String(normal.stdout || '') + String(normal.stderr || '')
  const textOnly = runProbe({ BF_TEXT_ONLY: '1' })
  const textOnlyOut = String(textOnly.stdout || '') + String(textOnly.stderr || '')
  const lines = out => out.split(/\r?\n/)
  const normalLine = lines(normalOut).find(l => l.startsWith('TOOLS=')) || ''
  const normalCount = (normalOut.match(/TOOL_COUNT=(\d+)/) || [])[1] || '?'
  const textOnlyCount = (textOnlyOut.match(/TEXT_ONLY_TOOLS=(\d+)/) || [])[1] || '?'
  if (normal.status === 0 && textOnly.status === 0) {
    add('有效工具面', 'green', '模型实际拿到的工具只有业务工具与语境工具（' + normalCount + ' 个），纯文本会话一个工具都不挂（' + textOnlyCount + ' 个）。' + normalLine, lines(normalOut).slice(-6).join('\n'))
  } else if (normalCount === '?' && normalOut.includes('PROBE_FAIL')) {
    add('有效工具面', 'yellow', '内核起不来（多半是产物未就绪），本轮跳过。', lines(normalOut).slice(-6).join('\n'))
  } else {
    add('有效工具面', 'red', '工具面回归：' + (normal.status === 0 ? '默认场景通过' : '默认场景失败（出现不该有的工具）') + '；' + (textOnly.status === 0 ? '纯文本场景通过' : '纯文本场景失败（仍有 ' + textOnlyCount + ' 个工具）'), lines(normalOut).slice(-8).join('\n') + '\n---\n' + lines(textOnlyOut).slice(-8).join('\n'))
  }
}

// 检查 5j3：前端产物必须是**当前源码**构建出来的
//
// 为什么需要它：内核与服务端的 lib 有 verify-runtime-lib-freshness.mjs 盯着，**前端产物没有**——
// 改完前端不重建 dist，源码运行时与出包都会继续用旧界面，而所有门禁都是绿的（与 DEF-160 同一族）。
const webFreshness = join(productRoot, 'qa', 'verify-web-bundle-freshness.mjs')
if (!existsSync(webFreshness)) {
  add('前端产物新鲜度', 'red', '缺少 verify-web-bundle-freshness.mjs。', webFreshness)
} else {
  const res = spawnSync(process.execPath, [webFreshness], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * 60 * 1000 })
  const out = String(res.stdout || '') + String(res.stderr || '')
  const line = out.split(/\r?\n/).find(l => l.startsWith('WEB_BUNDLE_FRESHNESS')) || ''
  if (out.includes('SKIP'))
    add('前端产物新鲜度', 'yellow', '前端还没构建过（跑一次 vite build --mode=test 才有可验的产物）。' + line, out.trim())
  else if (res.status === 0)
    add('前端产物新鲜度', 'green', 'dist 是当前前端源码构建出来的——改完前端忘了重建，这里会判红。' + line, out.trim())
  else
    add('前端产物新鲜度', 'red', '前端产物落后于源码：页面与出包用的都是旧界面，跑一次 vite build --mode=test。', out.trim())
}

// 检查 5j4：缺陷台账的**结构**（每行 11 格、编号唯一、关闭字段非空）
//
// 为什么需要它：上面那条「缺陷闭环留痕」只验字段非空，而台账是手写表格——单元格里的裸竖线会把行撑成十几格，
// 按位置取的字段就成了邻格的值；整行被合并时，没有 `| DEF-` 前缀的那条缺陷**从未进过门禁视野**（2026-09-22 实测，见 DEF-162）。
// 检查 5j5：平台规则一致性（站内规则表 = 教案；权威上限表 = 有出处的数字）。
//
// 为什么需要它：2026-10-11 实测，两处各写了一个抖音标题上限——教案写 ≤30（编的）、引擎实测 20，
// 模型照着 30 写字、引擎按 20 拒收，撞了很久的墙才被发现（DEF-253）。数字可以有第二处，但不能有两个真相。
const platformRulesProbe = join(productRoot, 'qa', 'verify-platform-rules.mjs')
if (!existsSync(platformRulesProbe)) {
  add('平台规则一致性', 'red', '缺少 verify-platform-rules.mjs。', platformRulesProbe)
} else {
  const res = spawnSync(process.execPath, [platformRulesProbe], { cwd: repoRoot, encoding: 'utf8', timeout: 60 * 1000 })
  const text = String(res.stdout || '') + String(res.stderr || '')
  const line = text.split(/\r?\n/).find(l => l.startsWith('PLATFORM_RULES')) || ''
  if (res.status === 0) add('平台规则一致性', 'green', '教案与权威上限表一致。' + line, text.trim())
  else add('平台规则一致性', 'red', '教案与权威上限表不一致。' + line, text.trim())
}

// 检查 5j6：**运行时语境**里的平台规则是否与权威表一致。
//
// 与 5j5 的分工：5j5 比对的是源码（agent-rules.ts），5j6 比对的是**模型真正读到的那份文件**
// （$BOSOM_FRIEND_HOME/AGENTS.md）。改了源码不等于语境刷新了——两者都要绿。
const contextRulesProbe = join(productRoot, 'qa', 'verify-context-rules.mjs')
if (!existsSync(contextRulesProbe)) {
  add('语境规则一致性', 'red', '缺少 verify-context-rules.mjs。', contextRulesProbe)
} else {
  const res = spawnSync(process.execPath, [contextRulesProbe], { cwd: repoRoot, encoding: 'utf8', timeout: 60 * 1000 })
  const text = String(res.stdout || '') + String(res.stderr || '')
  const line = text.split(/\r?\n/).find(l => l.startsWith('CONTEXT_RULES')) || ''
  if (res.status === 0) add('语境规则一致性', 'green', '语境里的平台规则与权威上限表一致。' + line, text.trim())
  else add('语境规则一致性', 'red', '语境与权威表不一致（语境是旧的？重启 + 新建会话后会刷新）。' + line, text.trim())
}

// 重构进度对账门禁（2026-10-11 补）：产品负责人两次指出「条例和标准都立好了，你怎么还会跑偏」——
// 文档只在被读的那一刻有效，读完就回到「按今天报上来的问题排优先级」。这道门禁强制进度表被持续维护。
// 记忆效能门禁（BFS-107.3）：同类任务的一次成功率/工具数/反问数，替代不合格的「墙钟时长」口径。
const memoryProbe = join(productRoot, 'qa', 'verify-memory-efficacy.mjs')
const refactorProbe = join(productRoot, 'qa', 'verify-refactor-progress.mjs')
const ledgerProbe = join(productRoot, 'qa', 'verify-defect-ledger.mjs')
if (!existsSync(ledgerProbe)) {
  add('缺陷台账结构', 'red', '缺少 verify-defect-ledger.mjs。', ledgerProbe)
add('重构进度对账', 'red', '缺少 verify-refactor-progress.mjs。', refactorProbe)
add('记忆效能(107.3)', 'yellow', '缺少 verify-memory-efficacy.mjs。', memoryProbe)
// G6 的「升级前后数据指纹一致」：升级只应改代码，不应改用户数据的条数。
add('数据指纹(G6)', 'yellow', '缺少 verify-data-fingerprint.mjs。', join(productRoot, 'qa', 'verify-data-fingerprint.mjs'))
} else {
  const res = spawnSync(process.execPath, [ledgerProbe], { cwd: repoRoot, encoding: 'utf8', timeout: 60 * 1000 })
  const out = String(res.stdout || '') + String(res.stderr || '')
  const line = out.split(/\r?\n/).find(l => l.startsWith('DEFECT_LEDGER')) || ''
  if (res.status === 0) add('缺陷台账结构', 'green', '台账每行 11 格、编号唯一、关闭字段齐全。' + line, out.trim())
  else add('缺陷台账结构', 'red', '台账结构坏了：单元格里的竖线要转义成 \\|，行尾不能吞掉分隔符，编号不能重复。', out.trim())
}

// 检查 5j5：对标看齐（「飞书 × 豆包工作」这条方向必须始终看得见）
//
// 为什么需要它：方向类文档最容易变成一次性宣言——写完没人再看，新功能也不再声明自己对标什么。
// 它盯三件事：基线判据在差距矩阵里都有状态、关键文档各自带一段「对标定位」并链接基线、
// 状态列只认 ✅/🟡/⛔。改了基线却没同步关键文档，这里会判红（负向对照已实测）。
const alignmentProbe = join(productRoot, 'qa', 'verify-benchmark-alignment.mjs')
if (!existsSync(alignmentProbe)) {
  add('对标看齐', 'red', '缺少 verify-benchmark-alignment.mjs，方向类文档无人盯。', alignmentProbe)
} else {
  const res = spawnSync(process.execPath, [alignmentProbe], { cwd: repoRoot, encoding: 'utf8', timeout: 60 * 1000 })
  const out = String(res.stdout || '') + String(res.stderr || '')
  const issues = out.split(/\r?\n/).filter((l) => l.trimStart().startsWith('- ')).slice(0, 8).join('\n')
  if (res.status === 0) add('对标看齐', 'green', '判据齐全、差距矩阵带状态、关键文档都带「对标定位」并链接基线。', out.trim())
  else add('对标看齐', 'red', '对标基线或关键文档没看齐：按基线 §4 补齐判据状态与「对标定位」段。', issues || out.trim())
}

// 检查 5j6：动作叫法一致（对标基线 F6：同一动作在不同对象上叫法一致）
//
// 为什么需要它：对象级 AI 动作的规格表在后端、按钮在前端，两边只靠动作 id 字符串对齐，
// 改一侧另一侧不会报错——前端多写一个不存在的 id，用户看到的是点了没反应。
const actionNamingProbe = join(productRoot, 'qa', 'verify-action-naming.mjs')
if (!existsSync(actionNamingProbe)) {
  add('动作叫法一致', 'red', '缺少 verify-action-naming.mjs，对象级动作的两侧无人对齐。', actionNamingProbe)
} else {
  const res = spawnSync(process.execPath, [actionNamingProbe], { cwd: repoRoot, encoding: 'utf8', timeout: 60 * 1000 })
  const out = String(res.stdout || '') + String(res.stderr || '')
  const issues = out.split(/\r?\n/).filter((l) => l.trimStart().startsWith('- ')).slice(0, 8).join('\n')
  if (res.status === 0) add('动作叫法一致', 'green', '动作 id 与对象种类对齐、文案同前缀同格式、前端只引用已登记动作。', out.trim())
  else add('动作叫法一致', 'red', '动作规格或文案两侧不一致：按 qa/verify-action-naming.mjs 点名的条目改。', issues || out.trim())
}

// 检查 5j8：VLOG 跨镜一致性（同一个形象跨镜还是不是同一个人）
//
// 为什么需要它：跨镜“不换人”是长视频的第一观感，而它只有真机跑厂商才验得了——
// 单测只能证明形象图与种子被传下去了。这条真调厂商出两条走动 VLOG（固定种子 vs 每镜换随机种子），
// 由产品配置里的模型判“是不是同一个人”（像素相似度被姿态与背景主导、量不出身份，探针里只作证据）。
// 会花额度与十几分钟。不想跑时设 BF_SKIP_VLOG_CONSISTENCY=1，以黄灯如实记“本轮没跑”。
const vlogProbe = join(productRoot, 'qa', 'probes', 'verify-vlog-consistency.mjs')
if (!existsSync(vlogProbe)) {
  add('VLOG 跨镜一致性（证据项）', 'red', '缺少 qa/probes/verify-vlog-consistency.mjs，跨镜换人无人盯。', vlogProbe)
} else if (process.env.BF_SKIP_VLOG_CONSISTENCY === '1') {
  add('VLOG 跨镜一致性（证据项）', 'yellow', '本轮显式跳过（真机跑厂商会花额度；不设 BF_SKIP_VLOG_CONSISTENCY=1 就会跑）。', '')
} else {
  const res = spawnSync(process.execPath, ['--import', 'tsx/esm', vlogProbe, '--shots', '2'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
  })
  const out = String(res.stdout || '') + String(res.stderr || '')
  const lines = out.split(/\r?\n/)
  const verdictLine = lines.find((l) => l.startsWith('VLOG_CONSISTENCY PASS') || l.startsWith('VLOG_CONSISTENCY FAIL') || l.startsWith('VLOG_CONSISTENCY SKIP')) ?? ''
  const tail = lines.filter(Boolean).slice(-10).join('\n')
  // 判据认**探针自己的结论行**，不认退出码：2026-09-24 第二轮实测探针被厂商连接超时打断
  // （fetch failed / UND_ERR_CONNECT_TIMEOUT），Node 以退出码 1 崩溃，而这里当时把 1 读成
  // "跨镜换人"——一次网络抖动被判成产品缺陷（假红）。崩溃与超时一律是黄灯（没验到），不是红。
  // 检查项名后的「证据项」是 2026-09-24 的准则修订（见 qa/RELEASE_CHECKLIST-v1.0.md 判据修订记录）：
  // 它的黄灯是"本轮没验到"，不参与准出——理由是外部判官对「同一个人」的判别接近随机（DEF-174）。
  if (verdictLine.startsWith('VLOG_CONSISTENCY PASS'))
    add('VLOG 跨镜一致性（证据项）', 'green', '同一形象的两条走动 VLOG 跨镜都是同一个人。' + verdictLine, tail)
  else if (verdictLine.startsWith('VLOG_CONSISTENCY FAIL'))
    add('VLOG 跨镜一致性（证据项）', 'red', '跨镜换人：同一形象的镜头之间判出了「不是同一个人」。' + verdictLine, tail)
  else if (verdictLine.startsWith('VLOG_CONSISTENCY SKIP'))
    add('VLOG 跨镜一致性（证据项）', 'yellow', '厂商或判官不可用，本轮没跑（不是跨镜换人）。' + verdictLine, tail)
  else if (res.status === null)
    add('VLOG 跨镜一致性（证据项）', 'yellow', '30 分钟内没跑完（厂商排队慢），本轮没拿到结论。', tail)
  else
    add('VLOG 跨镜一致性（证据项）', 'yellow', '探针异常退出（退出码 ' + String(res.status) + '，没有给出 PASS/FAIL/SKIP 结论）——按"没验到"记，不按跨镜换人记。', tail)
}

// 检查 5l：产品包必须过类型
//
// 为什么单独一条：`kernel` 包此前**不在任何编译面里**——没有 tsconfig，也没有被 CI 的
// "Typecheck product server" 步骤覆盖，只被 `esbuild --bundle` 打包，而 esbuild 不做类型检查。
// 它就这样带着两个类型错误活了很久（裸 `randomUUID()` 当品牌 id `MessageId`；
// `exactOptionalPropertyTypes` 下给可选属性赋 `undefined`），没有任何人发现。
// **类型不查，等于这一包没有类型。**
const productTypeTargets = [
  { label: '服务端', config: join(productRoot, 'server', 'tsconfig.json') },
  { label: '内核包', config: join(productRoot, 'kernel', 'tsconfig.json') },
]
const typeFailures = []
const typePassed = []
/** 用仓库自己那份 tsc 的 JS 入口跑：Windows 上 pnpm/npx 是 .cmd，spawnSync 直接调会失败。 */
const tscEntry = createRequire(import.meta.url).resolve('typescript/bin/tsc')
for (const target of productTypeTargets) {
  if (!existsSync(target.config)) {
    typeFailures.push(target.label + '：缺少 ' + relative(repoRoot, target.config))
    continue
  }
  const res = spawnSync(process.execPath, [tscEntry, '-p', target.config, '--noEmit', '--pretty', 'false'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  })
  if (res.status === 0) {
    typePassed.push(target.label)
  } else {
    const out = `${res.stdout || ''}${res.stderr || ''}`.split(/\r?\n/).filter(Boolean)
    typeFailures.push(target.label + '：' + out.slice(0, 3).join(' / '))
  }
}
// 前端单独一条：它一直是**没有任何类型检查在跑**的那一块（vite 走 esbuild 不查类型，
// 三个产品包里只有 server/kernel 在 CI 里过 tsc）。现存错误全是既有的，一次性清完要动
// 三个 store 的类型设计，所以先用棘轮把水位钉住（见 verify-frontend-types.mjs）。
const frontendTypesGate = join(productRoot, 'qa', 'verify-frontend-types.mjs')
if (!existsSync(frontendTypesGate)) {
  typeFailures.push('前端：缺少 verify-frontend-types.mjs')
} else {
  const res = spawnSync(process.execPath, [frontendTypesGate], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  })
  const summary = `${res.stdout || ''}${res.stderr || ''}`.split(/\r?\n/).find(line => line.startsWith('FRONTEND_TYPES')) ?? ''
  if (res.status === 0) typePassed.push('前端（棘轮 ' + summary.replace('FRONTEND_TYPES_OK ', '') + '）')
  else typeFailures.push('前端：' + (summary || '退出码 ' + res.status))
}
if (typeFailures.length > 0) {
  add('产品包类型', 'red', '有产品包没过类型检查：' + typeFailures.join('；'), typeFailures.join('\n'))
} else {
  add('产品包类型', 'green', typePassed.join('、') + ' 全部通过 tsc --noEmit。', typePassed.join('\n'))
}

// 检查 5k：内核包自带单测必须真的跑得起来
//
// 为什么单独一条：这些用例此前**没有任何门禁在跑**，其中一个读着数据店里根本不存在的
// `store.files.promotions`，每次都以 TypeError 结束而没人知道——"删除级联是对的"
// 一直是自说自话。测试不跑，比没有测试更危险。
const kernelTestDir = join(productRoot, 'kernel', 'test')
const kernelTestFiles = existsSync(kernelTestDir)
  ? readdirSync(kernelTestDir).filter(name => name.endsWith('.test.mjs')).sort()
  : []
if (kernelTestFiles.length === 0) {
  add('内核包单测', 'yellow', '没有找到 kernel/test/*.test.mjs。', kernelTestDir)
} else {
  const brokenKernelTests = []
  for (const name of kernelTestFiles) {
    const res = spawnSync(process.execPath, ['--import', 'tsx/esm', join(kernelTestDir, name)], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 2 * 60 * 1000,
    })
    if (res.status !== 0) {
      const out = `${res.stdout || ''}${res.stderr || ''}`
      brokenKernelTests.push(name + '：退出码 ' + res.status + '；' + out.split(/\r?\n/).filter(Boolean).slice(-3).join(' '))
    }
  }
  if (brokenKernelTests.length > 0) {
    add('内核包单测', 'red', '内核包自带单测没跑通：' + brokenKernelTests.join('；'), brokenKernelTests.join('\n'))
  } else {
    add('内核包单测', 'green', kernelTestFiles.length + ' 个内核单测全部通过：' + kernelTestFiles.join('、'), kernelTestFiles.join('\n'))
  }
}

// 检查 5m：开发文档索引必须与目录一致
//
// 为什么单独一条：docs 下有 80+ 份文档，手工维护的索引一定会过期——本仓库已经有过一次：
// `adr/README.md` 写着"暂无，待 Phase 1 立项"，而目录里已经躺着 5 篇 ADR。
// 索引一旦说谎，比没有索引更糟，所以它必须由门禁守着。
const docsIndexGate = join(productRoot, 'qa', 'verify-docs-index.mjs')
if (!existsSync(docsIndexGate)) {
  add('开发文档索引', 'red', '缺少 verify-docs-index.mjs。', docsIndexGate)
} else {
  const res = spawnSync(process.execPath, [docsIndexGate], { cwd: repoRoot, encoding: 'utf8', timeout: 2 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find(line => line.startsWith('DOCS_INDEX')) ?? ''
  if (res.status === 0) {
    add('开发文档索引', 'green', '每份文档都登记在总目里，ADR 索引与状态合规。' + summary, summary)
  } else {
    add('开发文档索引', 'red', '文档索引与目录不一致：' + summary, out.split(/\r?\n/).filter(Boolean).slice(0, 8).join('\n'))
  }
}

// 检查 5h：专业 E2E 套件（Playwright Test）：三大核心 CRUD + 关键不变量
const e2eDir = join(productRoot, 'qa', 'e2e')
if (!existsSync(join(e2eDir, 'playwright.config.ts'))) {
  add('专业 E2E 套件', 'red', '缺少 qa/e2e/playwright.config.ts。', e2eDir)
} else {
  let appUp = false
  try {
    const probe = await fetch((process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280') + '/bosom-friend/')
    appUp = probe.ok
  } catch { appUp = false }
  if (!appUp) {
    add('专业 E2E 套件', 'yellow', '开发版未运行，无法执行 Playwright 套件。')
  } else {
    // 30 分钟：套件里有真实模型调用（单条 25 秒 ~ 1.5 分钟），整套连跑实测 11~15 分钟；
    // 15 分钟会在模型稍慢时被整体杀掉，报告成"退出码 null：存在失败用例"——那是超时，不是产品红。
    const res = spawnSync('npx', ['playwright', 'test', '--reporter=list'], {
      cwd: e2eDir,
      encoding: 'utf8',
      shell: true,
      timeout: 30 * 60 * 1000,
      // BF_QA_ALLOW_SHARED：本门禁打的是**开发实例**（它的数据根就是用户数据），
      // 而套件会创建真实生成记录并写知识库。E2E 侧默认拒绝打共享实例，
      // 这里显式 opt-in 以保留门禁的既有行为；要跑在一次性数据根上就设 BF_QA_ORIGIN 指向隔离实例。
      env: {
        ...process.env,
        BF_QA_BASE: (process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280') + '/bosom-friend/',
        BF_QA_ALLOW_SHARED: '1',
      },
    })
    const out = `${res.stdout || ''}${res.stderr || ''}`
    const summary = out.split(/\r?\n/).find((l) => /\d+ (passed|failed)/.test(l)) ?? ''
    const tail = out.split(/\r?\n/).filter(Boolean).slice(-14).join('\n')
    if (res.status === 0) add('专业 E2E 套件', 'green', '内容创作 / AI 智能体 / 全局监控 的 CRUD 与关键不变量全部通过。', summary || tail)
    else add('专业 E2E 套件', 'red', `退出码 ${res.status}：${summary || '存在失败用例'}。`, tail)
  }
}

// 检查 5e：中断时序矩阵（DEF-001/DEF-022 同族：终态不得落定后翻转、停晚了不得谎称已中断）
const matrixGate = join(productRoot, 'qa', 'verify-abort-timing-matrix.mjs')
if (!existsSync(matrixGate)) {
  add('中断时序矩阵', 'red', '缺少 verify-abort-timing-matrix.mjs。', matrixGate)
} else {
  const res = spawnSync(process.execPath, [matrixGate], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 8 * 60 * 1000,
    env: { ...process.env, BF_QA_ORIGIN: process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280' },
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
  const summary = out.split(/\r?\n/).find((l) => l.startsWith('ABORT_MATRIX ')) ?? ''
  if (res.status === 0) add('中断时序矩阵', 'green', '五个时间点的停止（含收尾窗口）终态稳定、停晚了如实落 completed。', summary || tail)
  else if (res.status === 2) add('中断时序矩阵', 'yellow', '开发版未运行或模型不可用，无法执行时序矩阵。', tail)
  else add('中断时序矩阵', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}。`, tail)
}

// 检查 6：S 级前端验收 —— 2026-10-12 摘除。
// 《S 级前端监考 v4》已由 BFS-104-R《验收标准-一句话端到端》取代（qa/README.md:114），
// qa/acceptance/ 整个目录已删除。这里保留一条 yellow 而不是让这一项静默消失，
// 免得报告里"少了一项"却没人发现。
add('S 级前端验收', 'yellow', '已废止：S 级监考由 BFS-104-R 取代，判据落点为 qa/verify-one-sentence-e2e.mjs。')

// 检查 7：产品版本单源一致（安装包 / 页面 / 服务 / 注册表必须是同一个版本）
// 历史故障：设置页写死 v0.13.9，与桌面壳 0.2.x 脱节。开发机未装产品属正常，脚本以 SKIP 记录。
const versionGate = join(scriptDir, 'verify-product-version.mjs')
if (!existsSync(versionGate)) {
  add('产品版本单源一致', 'red', '缺少 verify-product-version.mjs，版本单源无从校验。', versionGate)
} else {
  const res = spawnSync(process.execPath, [versionGate], { cwd: repoRoot, encoding: 'utf8', timeout: 3 * 60 * 1000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim()
  const skips = out.split(/\r?\n/).filter((l) => l.startsWith('PRODUCT_VERSION_VERIFY SKIP '))
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
  if (res.status === 0) {
    add(
      '产品版本单源一致',
      'green',
      `版本权威 desktop/package.json；桌面壳、前端与已出货 dist 一致${skips.length > 0 ? `；本机未安装态跳过 ${skips.length} 项` : ''}。`,
      tail,
    )
  } else {
    add('产品版本单源一致', 'red', '版本号漂移：安装包、页面、服务或注册表不一致（禁止发布）。', tail)
  }
}

// 汇总与写报告
const now = new Date()
const stamp = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
  '-',
  String(now.getHours()).padStart(2, '0'),
  String(now.getMinutes()).padStart(2, '0'),
  String(now.getSeconds()).padStart(2, '0'),
].join('')
const reportsDir = join(scriptDir, 'reports')
mkdirSync(reportsDir, { recursive: true })
const reds = checks.filter((c) => c.status === 'red')
const yellows = checks.filter((c) => c.status === 'yellow')
const verdict = reds.length > 0 ? '红灯：禁止合并 / 发布' : yellows.length > 0 ? '黄灯：可继续开发，发布前必须处理' : '绿灯：通过'
const reportLines = [
  '# 门禁红绿灯报告',
  '',
  `- 时间：${now.toISOString()}`,
  `- 执行方式：${full ? '--full（含 S 级前端验收）' : '快速门禁'}`,
  `- Git 提交：${gitHead()}${gitDirty() ? '（工作区有未提交改动，本报告只对这份工作区有效）' : ''}`,
  `- 执行人：${process.env.USERNAME || process.env.USER || 'unknown'}`,
  `- 主机：${process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown'}`,
  `- 结论：${verdict}`,
  '',
  '## 检查结果',
  '',
]
for (const c of checks) {
  const label = c.status === 'red' ? '[红]' : c.status === 'yellow' ? '[黄]' : '[绿]'
  reportLines.push(`### ${label} ${c.name}`, '', c.detail, '')
  if (c.evidence) reportLines.push('```', c.evidence, '```', '')
}
const report = reportLines.join('\n')
writeFileSync(join(reportsDir, `gate-${stamp}.md`), report, 'utf8')
writeFileSync(join(reportsDir, 'latest.md'), report, 'utf8')
console.log(report)
process.exit(reds.length > 0 ? 1 : 0)
