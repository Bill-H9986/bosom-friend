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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
]
const llmHits = []
for (const d of sourceDirs) {
  const dir = join(productRoot, d)
  if (!existsSync(dir)) continue
  const files = await collectFiles(dir, (_p, name) => SOURCE_EXTS.has(extname(name).toLowerCase()))
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    text.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      if (/chat\/completions/.test(line)) llmHits.push(`${relative(repoRoot, f)}:${i + 1}`)
    })
  }
}
if (llmHits.length > 0) {
  const shown = llmHits.slice(0, 30).join('\n') + (llmHits.length > 30 ? `\n……共 ${llmHits.length} 处` : '')
  add('禁止直连模型接口', 'red', `发现 ${llmHits.length} 处直接调用 chat/completions，AI 路径必须经官方 DSH 内核。`, shown)
} else {
  add('禁止直连模型接口', 'green', '未发现直连 chat/completions。')
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

// 检查 5：模型配置端到端链路（保存 → 落盘 → DSH 设置/凭据 → 内核注册路由）
// 这条链跨四个环节，任何一环断开的表现都是"保存了但 AI 没反应"，必须真实跑。
const llmGate = join(productRoot, 'qa', 'verify-llm-config.mjs')
if (!existsSync(llmGate)) {
  add('模型配置链路', 'red', '缺少 verify-llm-config.mjs。', llmGate)
} else {
  const res = spawnSync(process.execPath, [llmGate], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    env: { ...process.env, BF_QA_ORIGIN: process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280' },
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const tail = out.split(/\r?\n/).slice(-14).join('\n')
  if (res.status === 0) add('模型配置链路', 'green', '保存→落盘→DSH 设置→内核路由 全部通过。', tail)
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

// 检查 5d：AI 智能体任务动作（C2-03 中断/继续 + C2-04 分享链接）
const agentGate = join(productRoot, 'qa', 'verify-agent-task-actions.mjs')
if (!existsSync(agentGate)) {
  add('AI 智能体任务动作', 'red', '缺少 verify-agent-task-actions.mjs。', agentGate)
} else {
  const res = spawnSync(process.execPath, [agentGate], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    env: { ...process.env, BF_QA_ORIGIN: process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280' },
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-10).join('\n')
  const summary = out.split(/\r?\n/).find((l) => l.startsWith('AGENT_TASK_ACTIONS ')) ?? ''
  if (res.status === 0) add('AI 智能体任务动作', 'green', '中断真的停、继续能接上、分享有效期与只读页全部通过。', summary || tail)
  else if (res.status === 2) add('AI 智能体任务动作', 'yellow', '开发版未运行或模型不可用，无法执行中断/分享检查。', tail)
  else add('AI 智能体任务动作', 'red', `退出码 ${res.status}：${summary || '存在失败断言'}。`, tail)
}

// 检查 5j：服务端功能测试（vitest，进程内驱动真实路由表：契约/状态机/落盘副作用）
const functionalDir = join(productRoot, 'server')
if (!existsSync(join(functionalDir, 'vitest.config.ts'))) {
  add('服务端功能测试', 'red', '缺少 server/vitest.config.ts。', functionalDir)
} else {
  const res = spawnSync('npx', ['vitest', 'run', '--config', 'server/vitest.config.ts'], {
    cwd: productRoot,
    encoding: 'utf8',
    shell: true,
    timeout: 5 * 60 * 1000,
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const summary = out.split(/\r?\n/).find((l) => /Tests\s+.*(passed|failed)/.test(l)) ?? ''
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
  if (res.status === 0) add('服务端功能测试', 'green', '路由契约、统计口径、批量删除语义、上传票据、路由表不变量全部通过（进程内，秒级）。', summary || tail)
  else add('服务端功能测试', 'red', `退出码 ${res.status}：${summary || '存在失败用例'}。`, tail)
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
    add('内核工具可执行', 'green', '10 个内核业务工具全部真跑一遍：注册齐全、execute 不抛错、render 出文本。' + passed.join('；'), passed.join('\n'))
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
      env: { ...process.env, BF_QA_BASE: (process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280') + '/bosom-friend/' },
    })
    const out = `${res.stdout || ''}${res.stderr || ''}`
    const summary = out.split(/\r?\n/).find((l) => /\d+ (passed|failed)/.test(l)) ?? ''
    const tail = out.split(/\r?\n/).filter(Boolean).slice(-14).join('\n')
    if (res.status === 0) add('专业 E2E 套件', 'green', '内容创作 / AI 智能体 / 全局监控 的 CRUD 与关键不变量全部通过。', summary || tail)
    else add('专业 E2E 套件', 'red', `退出码 ${res.status}：${summary || '存在失败用例'}。`, tail)
  }
}

// 检查 5e：中断时序矩阵（DEF-001/DEF-022 同族：终态不得落定后翻转、停晚了不得谎称已中断）
const matrixGate = join(productRoot, 'qa', 'acceptance', 'verify-abort-timing-matrix.mjs')
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

// 检查 6：S 级前端验收（仅 --full）
const gatePath = join(productRoot, 'qa', 'acceptance', 'frontend-supreme-gate.mjs')
if (full) {
  if (!existsSync(gatePath)) {
    add('S 级前端验收', 'red', '缺少 frontend-supreme-gate.mjs。', gatePath)
  } else {
    const res = spawnSync(process.execPath, [gatePath], {
      cwd: join(productRoot, 'qa', 'acceptance'),
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
    })
    const tail = `${res.stdout || ''}${res.stderr || ''}`.split(/\r?\n/).slice(-20).join('\n')
    if (res.status === 0) add('S 级前端验收', 'green', 'frontend-supreme-gate.mjs 通过。', tail)
    else add('S 级前端验收', 'red', `退出码 ${res.status}。`, tail)
  }
} else {
  add('S 级前端验收', 'yellow', '未执行：需要 --full，且应用处于可运行状态。')
}

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
