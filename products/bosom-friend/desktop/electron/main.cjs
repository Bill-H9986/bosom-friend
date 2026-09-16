
/**
 * Bosom Friend 0.2.0 desktop main process.
 *
 * This is the only product lifecycle owner. It never opens an external browser, never
 * disables Electron sandboxing, and never kills processes by name.
 */

const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, execFile, execFileSync } = require('child_process')

/**
 * 内核运行时目录。
 *
 * 安装期由 build/installer.nsh 解压到固定目录 userData/kernel-runtime，并在每次安装时
 * 重新解压，所以该目录里的运行时必然与安装版本一致（417MB / 约 23 万个文件压到首次启动
 * 会让低配机器在启动页等十几分钟）。
 *
 * 兜底只在 resources/kernel-runtime.zip 还在时可用：安装器解压成功后就会删掉它（省 417MB）。
 * 因此"固定目录缺失 + zip 也已删除"的机器，唯一出路是重新运行安装包做修复安装——
 * ensureKernelExtracted() 会把这句话直接说给用户，而不是丢一句"内核运行时缺失"。
 *
 * zip 还在时走 kernel-extract.cjs 的工具阶梯：系统 tar 绝对路径 → PATH 上的 tar →
 * **自带解压器 kernel-unzip.cjs** → 随包 Python。只认绝对路径和随包运行时，不假设用户机器上有
 * tar，也不把 libuv 的原文当错误文案（DEF-045）。
 *
 * 自带解压器是保底那一步：系统 tar 与随包 Python 都过不了 MAX_PATH 260（长路径支持默认关闭），
 * 而这份 zip 解到 userData 之后最深路径接近 290 字符。探测到本机没开长路径时，阶梯直接把
 * 自带解压器提到最前，不让用户白等一次注定失败的 tar（DEF-055）。
 */
function kernelRootForVersion() {
  const installed = path.join(app.getPath('userData'), 'kernel-runtime')
  if (fs.existsSync(path.join(installed, 'runtime', 'bin-desktop.mjs'))) return installed
  return path.join(app.getPath('userData'), 'kernel-runtime-' + app.getVersion())
}
/**
 * 自带解压器脚本路径（kernel-unzip.cjs）。
 *
 * 打包态优先用 `resources/kernel-unzip.cjs`：那是 extraResources 直接放的同一份文件，
 * 安装器（NSIS 跑不了 asar 里的代码）也要用它，两边必须是同一个实现。
 *
 * @returns 可执行脚本的绝对路径。
 */
function kernelUnzipScript() {
  const packaged = path.join(process.resourcesPath, 'kernel-unzip.cjs')
  if (app.isPackaged && fs.existsSync(packaged)) return packaged
  return path.join(__dirname, 'kernel-unzip.cjs')
}

/**
 * 跑自带解压器的 Node。
 *
 * 打包态用随包 `resources/runtime/node.exe`（真 Node 24，安装器同一条命令）；
 * 开发态与"随包 node 缺失"时退回 Electron 自身（`ELECTRON_RUN_AS_NODE=1` 让 Electron 当 Node 跑）。
 *
 * @returns `{ command, env }`，`env` 需要合并进子进程环境。
 */
function nodeUnzipCommand() {
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'node.exe') : ''
  if (bundled !== '' && fs.existsSync(bundled)) return { command: bundled, env: {} }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * 探测本机能不能写超过 MAX_PATH 260 的路径。
 *
 * 不去读注册表：LongPathsEnabled 是机器级设置、且**按进程缓存**（微软文档明说进程启动后不再重载），
 * 读到的值和"这个进程现在能不能写长路径"不是一回事。直接在最深处建目录写文件读回来，
 * 用真实结果决定阶梯顺序，也顺手拿到"为什么别的解压工具在这台机器上必失败"的证据。
 *
 * @param root - 解压目标目录（已存在）。
 * @returns 能写超过 260 字符的路径时 true；失败或探测本身出错时 false。
 */
function probeLongPaths(root) {
  const segment = 'bf-longpath-probe-' + '0123456789'.repeat(6)
  const probeDir = path.join(root, segment, segment, segment)
  const probeFile = path.join(probeDir, 'probe.txt')
  if (probeFile.length <= 260) return true
  let writable = false
  try {
    fs.mkdirSync(toLongPath(probeDir), { recursive: true })
    fs.writeFileSync(toLongPath(probeFile), '1')
    writable = fs.readFileSync(toLongPath(probeFile), 'utf8') === '1'
  }
  catch {
    writable = false
  }
  finally {
    // 探测痕迹必须清干净：这条路本身就在"写不进去"的机器上跑，残留会变成新的脏目录。
    // 删除同样走 \\?\ 前缀，否则"没开长路径"的机器连自己刚建的深目录都删不掉。
    try {
      fs.rmSync(toLongPath(path.join(root, segment)), { recursive: true, force: true })
    }
    catch {
      // 删不掉只影响一个探测目录，不影响判定结果。
    }
  }
  return writable
}

/**
 * 解压失败的诊断留痕。
 *
 * 错误框只放一句脱敏的话（AC-021-3），排查需要的是完整事实：解压计划、每一步的真实原因、
 * 长路径探测结果、zip 大小与目标目录。写进 userData 的一个小文件里，现场机器可以直接取回。
 *
 * @param facts - 本次解压的环境事实。
 * @param error - {@link runExtractPlan} 抛出的错误（带 `failures` 数组）。
 */
function writeExtractLog(facts, error) {
  const lines = [
    'at=' + new Date().toISOString(),
    'version=' + app.getVersion(),
    'zip=' + facts.zip,
    'target=' + facts.target,
    'longPathsWritable=' + String(facts.longPathsEnabled),
    'plan=' + facts.plan.join(' > '),
    'message=' + (error instanceof Error ? error.message : String(error)),
  ]
  for (const failure of Array.isArray(error?.failures) ? error.failures : []) {
    lines.push('step=' + failure.source + ' code=' + failure.code + ' reason=' + failure.reason)
  }
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'kernel-extract.log'), lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8')
  }
  catch {
    // 日志写不进去不该改变失败本身：用户看到的错误框与重试路径都不依赖它。
  }
}

/**
 * 清掉旧版内核运行时目录。
 *
 * kernelRootForVersion() 在固定目录不可用时会回退到 kernel-runtime-<version>，
 * 于是每次升级都可能留下上一版那一份。实测在一台机器上堆到 8 份、合计 8.9 GB，
 * 而卸载器不碰这里。这些目录都能从安装包重新解压，启动时删掉除当前版本以外的全部。
 *
 * 删除必须走异步 fs.promises.rm：一份运行时约 417MB / 23 万个文件，同步 rmSync 会把
 * 主进程的事件循环占满几分钟（机械盘更久），这期间窗口显示与 IPC 全部停摆——
 * 表现出来就是低配机器上启动页卡死不动。
 *
 * @returns 真正删掉的目录数；失败（被占用）的留到下次启动再试。
 */
async function pruneStaleKernelRuntimes() {
  const userData = app.getPath('userData')
  const keep = 'kernel-runtime-' + app.getVersion()
  let entries = []
  try {
    entries = await fs.promises.readdir(userData, { withFileTypes: true })
  } catch {
    return 0
  }
  const stale = entries.filter(entry => entry.isDirectory()
    && /^kernel-runtime(-|$)/.test(entry.name)
    && entry.name !== 'kernel-runtime'
    && entry.name !== keep)
  let removed = 0
  for (const entry of stale) {
    reportProgress('clean', {
      fraction: stale.length === 0 ? 1 : removed / stale.length,
      detail: '正在清理旧版内核运行时 ' + (removed + 1) + '/' + stale.length + '（' + entry.name + '）',
    })
    try {
      await fs.promises.rm(path.join(userData, entry.name), { recursive: true, force: true })
      removed += 1
    } catch {
      // 目录被占用（上次异常退出留下的句柄）不该拦住启动；下次启动再试。
    }
  }
  return removed
}

if (app.isPackaged) {
  process.env.BF_KERNEL_ROOT = kernelRootForVersion()
}
// 版本权威：前端 __APP_VERSION__ 由服务端注入，服务端从这里取值。
process.env.BOSOM_FRIEND_VERSION = app.getVersion()

/**
 * 准备随包分发的平台 Python 引擎（打包态）。
 *
 * 安装包内 resources/engine 由 build-engine-portable.ps1 组装：引擎源码 + .venv +
 * 便携 Python + patchright 浏览器。这里注入服务端读取的路径、指定浏览器目录，
 * 并把 .venv/pyvenv.cfg 的 home 改写成随包的 python-base（源码态该文件指向开发机
 * Python，直接分发到用户机器会找不到解释器）。
 */
function preparePackagedEngine() {
  if (!app.isPackaged) return
  const root = path.join(process.resourcesPath, 'engine')
  if (!fs.existsSync(root)) return
  process.env.BF_ENGINE_ROOT = root
  process.env.BF_ENGINE_VENDOR_ROOT = path.join(root, 'social-auto-upload')
  const browsers = path.join(root, 'browsers')
  if (fs.existsSync(browsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
  // B 站发布走 biliup 二进制。随包一份，否则首次发布会去 GitHub 现下（实测 225 秒）。
  const biliup = path.join(root, 'tools', 'biliup')
  if (fs.existsSync(biliup)) process.env.BF_BILIUP_ROOT = biliup
  const cfg = path.join(root, '.venv', 'pyvenv.cfg')
  const pythonBase = path.join(root, 'python-base')
  try {
    if (fs.existsSync(cfg) && fs.existsSync(pythonBase)) {
      const body = fs.readFileSync(cfg, 'utf8').replace(/^\uFEFF?home\s*=.*$/m, 'home = ' + pythonBase)
      fs.writeFileSync(cfg, body)
    }
  }
  catch {
    // 引擎目录只读或缺失时保持原样：后续探针会如实报"Python 环境缺失"。
  }
}
const { createKernelHost, repoRoot } = require('./kernel-host.cjs')
const { detectPerfProfile, applyPerfEnv, writePerfProfile } = require('./perf-profile.cjs')
const { SOURCE_LABELS, buildExtractPlan, runExtractPlan, kernelRuntimeReady, failureReason } = require('./kernel-extract.cjs')
const { toLongPath } = require('./kernel-unzip.cjs')

const DESKTOP_PORT = Number.parseInt(process.env.BF_DESKTOP_PORT || '31280', 10)
const DESKTOP_URL = `http://127.0.0.1:${Number.isFinite(DESKTOP_PORT) && DESKTOP_PORT > 0 ? DESKTOP_PORT : 31280}/bosom-friend/`

let mainWindow = null
let tray = null
let quitting = false
let startedAt = Date.now()
let kernelHost = null
let lastHandshake = null
let kernelError = ''
/** 接入既有服务时的提示（启动页展示，解释为什么内核没有自己启动）。 */
let attachedNote = ''

/**
 * 本机性能档位（低配适配的唯一判定来源）。
 *
 * 必须在启动内核之前测定并写进环境变量：档位要随环境传给内核子进程（堆上限）与服务端
 * （备份保留份数 / 接待引擎轮询间隔 / 前端重特效开关）。
 */
const PERF = detectPerfProfile(process.env)
applyPerfEnv(PERF)

/**
 * GPU 崩溃留痕：同一个原因连续两次才退回软件渲染。
 *
 * 单次崩溃可能是驱动偶发；连续两次说明这台机器的显卡/驱动确实跑不了硬件加速，
 * 再让用户对着白屏窗口猜原因就是缺陷。标记落盘，用户不需要懂任何命令行参数。
 */
const GPU_CRASH_MARKER = 'gpu-crash.json'

/** @returns 读到的 GPU 崩溃留痕；没有或损坏时返回 `{ crashes: 0 }`。 */
function readGpuCrashMarker() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), GPU_CRASH_MARKER), 'utf8'))
    if (raw && Number.isFinite(raw.crashes)) return raw
  }
  catch {
    // 没有标记文件（绝大多数机器）：保持硬件加速。
  }
  return { crashes: 0 }
}

/** @returns 需要软件渲染时的原因；空串表示继续使用硬件加速。 */
function gpuFallbackReason() {
  if (process.env.BF_DISABLE_GPU === '1') return '按 BF_DISABLE_GPU=1 指定'
  const marker = readGpuCrashMarker()
  if (marker.crashes >= 2) return '显卡加速连续 ' + marker.crashes + ' 次崩溃（' + (marker.lastReason ?? '未知原因') + '）'
  return ''
}

/** 记一次 GPU 崩溃；连续两次后下次启动自动软件渲染。 */
function recordGpuCrash(reason) {
  const marker = readGpuCrashMarker()
  const next = { crashes: (marker.crashes ?? 0) + 1, lastReason: String(reason ?? ''), at: new Date().toISOString() }
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), GPU_CRASH_MARKER), JSON.stringify(next, null, 2), 'utf8')
  }
  catch {
    // 写不进去只影响"下次自动退回软件渲染"，不影响本次继续运行。
  }
}

/** 硬件加速连续稳定运行后清除留痕，避免一次偶发崩溃永久降级。 */
function clearGpuCrashMarker() {
  try {
    fs.rmSync(path.join(app.getPath('userData'), GPU_CRASH_MARKER), { force: true })
  }
  catch {
    // 标记不存在或被占用：保持现状。
  }
}

/**
 * 启动阶段与权重。
 *
 * 每个阶段对应一个能观测到结束的真实动作；测不出长度的阶段（解压运行时、内核握手、
 * 等待前端）标记 `indeterminate`，启动页显示扫光与已用时，不按时间假装百分比。
 */
const STARTUP_STAGES = [
  { id: 'check', label: '检查运行环境', weight: 6 },
  { id: 'clean', label: '清理旧版运行时残留', weight: 6 },
  { id: 'verify', label: '校验内核运行时', weight: 18 },
  { id: 'kernel', label: '启动内核服务', weight: 50 },
  { id: 'ui', label: '加载产品界面', weight: 20 },
]
const TOTAL_WEIGHT = STARTUP_STAGES.reduce((sum, stage) => sum + stage.weight, 0)

/** 启动进度快照：启动页既订阅事件，也用 getStatus 兜住订阅之前的里程碑。 */
let progress = {
  stage: 'check',
  index: 1,
  total: STARTUP_STAGES.length,
  label: STARTUP_STAGES[0].label,
  percent: 0,
  indeterminate: true,
  detail: '',
  slowAfterMs: PERF.caps.slowAfterMs,
  at: Date.now(),
}

/**
 * 内核握手等待预算（毫秒）。
 *
 * @returns 环境变量 BF_KERNEL_HANDSHAKE_TIMEOUT_MS 的合法值；未设置或非法时按性能档位取值。
 */
function handshakeTimeoutMs() {
  const override = Number.parseInt(process.env.BF_KERNEL_HANDSHAKE_TIMEOUT_MS ?? '', 10)
  if (Number.isFinite(override) && override >= 1000 && override <= 3600_000) return override
  return PERF.caps.handshakeTimeoutSeconds * 1000
}

/**
 * 等待产品服务就绪的上限（秒）。
 *
 * @returns 环境变量 BF_STARTUP_WAIT_SECONDS 的合法值；未设置或非法时按性能档位取值。
 */
function startupWaitSeconds() {
  const override = Number.parseInt(process.env.BF_STARTUP_WAIT_SECONDS ?? '', 10)
  if (Number.isFinite(override) && override >= 5 && override <= 3600) return override
  return PERF.caps.startupWaitSeconds
}

/**
 * 最近若干次进度里程碑。
 *
 * 用户报"卡在 30%"时，只有当前快照说不清是"哪一步慢"还是"哪一步没做完"；
 * 留一串带时间戳的里程碑，排查时能直接看到启动到底走到了哪一步。
 * 上限固定，只留内存，不落盘（启动日志不该变成无界增长的文件）。
 */
const PROGRESS_LOG_LIMIT = 40
let progressLog = []

/** 阶段起点权重（该阶段之前的全部权重和）。 */
function stageWeightBefore(stageId) {
  let sum = 0
  for (const stage of STARTUP_STAGES) {
    if (stage.id === stageId) break
    sum += stage.weight
  }
  return sum
}

/**
 * 上报一个真实里程碑。
 *
 * 百分比单调不减：迟到或乱序的上报不得让启动页回退。`fraction` 只用于阶段内部
 * 可数完的工作（如"清理 2/3 份旧运行时"），测不出长度的阶段不要传它。
 */
function reportProgress(stageId, options = {}) {
  const index = STARTUP_STAGES.findIndex(stage => stage.id === stageId)
  if (index === -1) return
  const stage = STARTUP_STAGES[index]
  // 不确定态 = 这一步测不出长度，因此百分比一律冻结在阶段起点：进度条可以不动，
  // 但不能按时间或按猜测往前爬——那样"卡死"和"正在启动"又会变成同一个界面。
  const fraction = options.indeterminate === true ? 0 : Math.min(1, Math.max(0, options.fraction ?? 0))
  const raw = ((stageWeightBefore(stageId) + stage.weight * fraction) / TOTAL_WEIGHT) * 100
  progress = {
    stage: stageId,
    index: index + 1,
    total: STARTUP_STAGES.length,
    label: options.label ?? stage.label,
    percent: Math.max(progress.percent, Math.round(raw)),
    indeterminate: options.indeterminate === true,
    detail: options.detail ?? '',
    slowAfterMs: progress.slowAfterMs,
    at: Date.now(),
  }
  const last = progressLog.at(-1)
  // 同一阶段同一百分比只记一次：留痕要能看出"换了一步"，而不是被重复上报刷满。
  if (last === undefined || last.stage !== progress.stage || last.percent !== progress.percent || last.detail !== progress.detail) {
    progressLog = [...progressLog, { ...progress }].slice(-PROGRESS_LOG_LIMIT)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bosom-kernel:progress', progress)
  }
}

/** 重新启动（重试）时把进度与留痕归零，避免沿用上一轮的百分比。 */
function resetProgress() {
  progressLog = []
  progress = {
    stage: 'check',
    index: 1,
    total: STARTUP_STAGES.length,
    label: STARTUP_STAGES[0].label,
    percent: 0,
    indeterminate: true,
    detail: '',
    slowAfterMs: PERF.caps.slowAfterMs,
    at: Date.now(),
  }
}

/** 面向普通用户的错误脱敏：只保留首行原因，隐藏内部路径与调用栈（AC-021-3）。 */
function sanitizeKernelError(error) {
  const raw = error instanceof Error ? error.message : String(error)
  const firstLine = raw.split(/\r?\n/)[0].trim()
  return firstLine
    .replace(/[A-Za-z]:\\[^\s]*|file:\/\/\/[^\s]*/g, '[内部路径已隐藏]')
    .slice(0, 300)
}

/** Exact child PIDs owned by this product instance. */
const managedChildren = new Map()

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function killExactPidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return
  execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 8000,
    stdio: 'ignore',
  }, () => {})
}

/** 递归枚举并强制结束指定主进程的全部后代（含托孤子进程），确保退出后零残留。 */
function killDescendantTree(rootPid) {
  const script = [
    '$ids=@(Get-CimInstance Win32_Process);',
    `$frontier=@(${rootPid});$all=@();`,
    'while($frontier.Count -gt 0){$next=@();foreach($id in $frontier){foreach($child in ($ids | Where-Object { $_.ParentProcessId -eq $id })){if($all -notcontains $child.ProcessId){$all += $child.ProcessId;$next += $child.ProcessId}}};$frontier=$next};',
    'foreach($id in $all){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}',
  ].join('')
  try {
    // 同步执行：必须在 app.quit() 之前完成，否则异步杀进程会错过托孤子进程。
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 10000,
      stdio: 'ignore',
    })
  } catch {
    // 枚举或结束失败不影响继续退出自身。
  }
}

/**
 * Track a child process owned by the desktop app.
 * On exit the exact PID is forgotten; nothing scans process names.
 */
function registerManagedChild(child) {
  if (!child || !child.pid) {
    return child
  }
  managedChildren.set(child.pid, child)
  child.once('exit', () => {
    managedChildren.delete(child.pid)
  })
  return child
}

/**
 * Stop all owned children. Graceful first, exact PID tree only after a bounded timeout.
 * This function never enumerates processes, never matches process names, and never
 * touches processes outside the owned PID set.
 */
async function stopManagedChildren() {
  const children = [...managedChildren.values()]
  for (const child of children) {
    try {
      child.kill()
    }
    catch {
      // Ignore already-exited children.
    }
  }

  await Promise.all(children.map(child => waitForExit(child, 1800)))

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      killExactPidTree(child.pid)
    }
  }
  managedChildren.clear()
}

async function quitAndStop() {
  if (quitting)
    return
  quitting = true
  // 完全退出必须有界：任何一步卡住都不能让主进程变成“隐藏占锁”实例。
  const cleanup = (async () => {
    if (kernelHost) {
      await Promise.race([
        kernelHost.close().catch(() => {}),
        new Promise((resolveWait) => setTimeout(resolveWait, 1500)),
      ])
      kernelHost = null
    }
    await Promise.race([
      stopManagedChildren(),
      new Promise((resolveWait) => setTimeout(resolveWait, 1500)),
    ])
  })()
  await Promise.race([cleanup, new Promise((resolveWait) => setTimeout(resolveWait, 3000))])
  // 退出前先清空全部后代进程树，杜绝 Electron 收尾不完整产生的孤儿/隐藏实例。
  killDescendantTree(process.pid)
  app.quit()
  // 兜底：极少数情况下 app.quit 未能终结，5 秒后强制结束整棵进程树，绝不残留。
  setTimeout(() => killExactPidTree(process.pid), 5000)
}

async function startKernel() {
  try {
    reportProgress('check', { fraction: 0.3, detail: '检查运行环境与随包资源' })
    // 视频档位合成使用随包 ffmpeg；服务端优先读取该环境变量，避免依赖用户机器安装。
    process.env.FFMPEG_PATH = app.isPackaged
      ? path.join(process.resourcesPath, 'runtime', 'ffmpeg.exe')
      : path.join(__dirname, '..', 'dist', 'runtime', 'ffmpeg.exe')
    process.env.BF_ENGINE_ROOT = app.isPackaged
      ? path.join(process.resourcesPath, 'engine')
      : path.join(repoRoot, 'products', 'bosom-friend', 'engine')
    process.env.BF_ENGINE_VENDOR_ROOT = app.isPackaged
      ? path.join(process.resourcesPath, 'engine', 'social-auto-upload')
      : path.join(repoRoot, 'products', 'bosom-friend', 'engine', 'social-auto-upload')
    if (app.isPackaged) {
      reportProgress('check', { fraction: 1, detail: '安装完整性检查通过' })
      const removed = await pruneStaleKernelRuntimes()
      reportProgress('clean', {
        fraction: 1,
        detail: removed > 0 ? '已清理 ' + removed + ' 份旧版内核运行时' : '没有需要清理的旧版运行时',
      })
      // 注意：pruneStaleKernelRuntimes 内部按"第几份 / 共几份"上报真实进度（可数的量），
      // 因此它报告的是 determinate 进度，而不是不确定态。
      // 解压是「有没有必要做」都不确定的阶段：需要时给出不确定态与真实提示，不假装百分比。
      reportProgress('verify', { indeterminate: true, detail: '校验内核运行时（首次启动需解压，机械盘会慢一些）' })
      await ensureKernelExtracted()
      reportProgress('verify', { fraction: 1, detail: '内核运行时就绪' })
      preparePackagedEngine()
      process.env.BF_KERNEL_ROOT = kernelRootForVersion()
    } else {
      // 开发态同样为 server 的 BYOK kernel-client 提供绝对运行时根，避免
      // server/lib/types 的相对路径推算差异导致找到 products/products/... 的错误路径。
      process.env.BF_KERNEL_ROOT = path.join(repoRoot, 'products', 'bosom-friend', 'desktop', 'dist', 'kernel-runtime-unpacked')
    }
    process.env.BF_FRONTEND_DIST = app.isPackaged
      ? path.join(process.resourcesPath, 'frontend-dist')
      : path.join(repoRoot, 'products', 'bosom-friend', 'project', 'bosom-friend-electron', 'dist')
    if (typeof process.loadEnvFile === 'function') {
      try {
        process.loadEnvFile(path.join(repoRoot, '.env'))
      }
      catch {
        // Missing or unreadable .env: keep the inherited environment.
      }
    }
    // 端口上已有 Bosom Friend 在服务（上一次没退干净的实例，或开发版正在跑）：
    // 再起一个内核必然 listen EADDRINUSE，握手失败后旧逻辑直接卡在启动页。
    // 这种情况直接接入既有服务，用户至少能进应用。
    if (await isProductServing()) {
      lastHandshake = null
      kernelError = ''
      attachedNote = '已接入正在运行的 Bosom Friend 服务'
      reportProgress('kernel', { fraction: 1, detail: '已接入正在运行的 Bosom Friend 服务' })
      const attached = await navigateToProduct()
      if (!attached) {
        kernelError = '检测到已有实例在运行，但产品页加载失败，请完全退出后重试'
      }
      return
    }
    reportProgress('kernel', { indeterminate: true, detail: '正在启动内核进程' })
    kernelHost = await createKernelHost({
      provider: process.env.BF_KERNEL_PROVIDER ?? 'deepseek-official',
      model: process.env.BF_KERNEL_MODEL ?? 'deepseek-v4-flash',
      // 握手预算按性能档位给：低配机器冷启动几分钟是正常的，标准机器则不该无限等。
      // 现场支持可以用 BF_KERNEL_HANDSHAKE_TIMEOUT_MS 临时收紧或放宽，不必重新发版。
      handshakeTimeoutMs: handshakeTimeoutMs(),
    })
    reportProgress('kernel', { indeterminate: true, detail: '内核进程已启动，等待初始化握手' })
    lastHandshake = await kernelHost.start()
    kernelError = ''
    reportProgress('kernel', { fraction: 1, detail: '内核初始化完成' })
    const pageReady = await navigateToProduct()
    kernelError = pageReady ? kernelError : '产品前端未能加载（服务未就绪）'
    kernelHost.subscribe((notification) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bosom-kernel:event', notification)
      }
    })
  }
  catch (error) {
    kernelError = sanitizeKernelError(error)
    lastHandshake = null
    reportProgress('kernel', { indeterminate: true, detail: '内核启动未完成，尝试接入既有服务' })
    // 握手失败也可能是端口被既有实例占用：仍然尝试接入产品页，避免永远停在启动页。
    const attached = await navigateToProduct()
    if (attached) {
      attachedNote = '已接入正在运行的 Bosom Friend 服务（本实例内核未启动）'
      kernelError = ''
    }
    else if (kernelError !== '') {
      kernelError = kernelError + '；产品服务未就绪'
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bosom-kernel:handshake', { handshake: lastHandshake, error: kernelError })
  }
}

/** 产品页是否已经在某个实例上服务（用于避免再起一个注定 EADDRINUSE 的内核）。 */
async function isProductServing() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const response = await fetch(DESKTOP_URL, { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  }
  catch {
    return false
  }
}

/**
 * 轮询产品服务并加载界面。
 *
 * 低配机器（机械盘 + 冷启动内核）实测能超过 60 秒，因此按性能档位给出不同的等待上限：
 * 宁可多等一会儿，也不要在机器还在正常启动时把用户推进"启动失败"的界面。
 */
async function navigateToProduct() {
  const attempts = startupWaitSeconds()
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(DESKTOP_URL)
      if (response.ok && mainWindow && !mainWindow.isDestroyed()) {
        reportProgress('ui', { fraction: 1, detail: '产品界面已就绪' })
        await mainWindow.loadURL(DESKTOP_URL)
        return true
      }
    } catch {
      // 服务未就绪，继续等待
    }
    if (attempt % 5 === 0) {
      reportProgress('ui', {
        indeterminate: true,
        detail: '等待产品服务就绪（已等待 ' + attempt + ' 秒，最长 ' + attempts + ' 秒）',
      })
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  }
  return false
}

/**
 * 把自带解压器的 stdout 进度行接到启动页。
 *
 * 解压是启动链路里最长的一步（417MB / 20 万个文件），只有它测得出长度：所以这一步用真实
 * 的"已解压 / 总数"推进百分比，而不是像以前那样整段走不确定态扫光。
 *
 * @param child - 自带解压器子进程。
 */
function attachUnzipProgress(child) {
  const stdout = child.stdout
  if (!stdout || typeof stdout.on !== 'function') return
  let buffered = ''
  stdout.setEncoding('utf8')
  stdout.on('data', (chunk) => {
    buffered += chunk
    const lines = buffered.split(String.fromCharCode(10))
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      const match = /^UNZIP_PROGRESS (\d+) (\d+)$/.exec(line.trim())
      if (match === null) continue
      const done = Number(match[1])
      const total = Number(match[2])
      reportProgress('verify', {
        fraction: total > 0 ? done / total : 0,
        detail: '正在解压内置运行时 ' + done + '/' + total + '（首次启动会慢一些）',
      })
    }
  })
}

async function ensureKernelExtracted() {
  // 内核运行时由安装器解压到用户数据目录；此处仅在运行时不在原位时兜底补解压。
  const kernelRootPackaged = kernelRootForVersion()
  if (kernelRuntimeReady(kernelRootPackaged)) {
    return
  }
  const zip = path.join(process.resourcesPath, 'kernel-runtime.zip')
  if (!fs.existsSync(zip)) {
    // 安装器解压完就删掉 zip，所以正常安装过的机器走到这里说明运行时真的没了。
    // 说清"怎么办"，不要让用户对着"内核运行时缺失"猜（他能做的只有重新运行安装包）。
    throw new Error('内核运行时缺失，请重新运行安装包完成修复安装（BosomFriend-Setup-*.exe），再打开本程序')
  }
  // tar -C 与 python -m zipfile -e 都不会自己创建目标目录；缺目录时它们只会报一句 chdir 失败。
  fs.mkdirSync(kernelRootPackaged, { recursive: true })
  const longPathsEnabled = probeLongPaths(kernelRootPackaged)
  const node = nodeUnzipCommand()
  const plan = buildExtractPlan({
    zip,
    target: kernelRootPackaged,
    env: process.env,
    resourcesPath: process.resourcesPath,
    longPathsEnabled,
    node: { command: node.command, script: kernelUnzipScript(), env: node.env },
  })
  const facts = { zip, target: kernelRootPackaged, longPathsEnabled, plan: plan.map(step => step.source) }
  try {
    // 逐条尝试（长路径不可用时自带解压器优先；否则系统 tar → PATH tar → 自带解压器 → 随包 Python），
    // 每一步都要真的把运行时入口解出来才算成功；子进程交给 registerManagedChild 托管。
    await runExtractPlan(plan, {
      cwd: path.dirname(zip),
      timeoutMs: 30 * 60 * 1000,
      onAttempt: (step) => {
        const label = SOURCE_LABELS[step.source] ?? step.source
        reportProgress('verify', { indeterminate: true, detail: '正在解压内置运行时（' + label + '，机械盘会慢一些）' })
      },
      onChild: (child) => {
        registerManagedChild(child)
        attachUnzipProgress(child)
      },
      verify: () => kernelRuntimeReady(kernelRootPackaged),
    })
  }
  catch (error) {
    writeExtractLog(facts, error)
    throw error
  }
  // 与安装器同一契约：解压成功后不再留这份 417MB 的 zip（安装成功的机器上它早被安装器删了）。
  try {
    fs.rmSync(zip, { force: true })
  }
  catch {
    // zip 被占用或位于只读介质：留着不影响启动，只是多占 417MB。
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  if (mainWindow.isMinimized())
    mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 托盘：关闭窗口后进程仍在后台，从这里重新打开窗口或完全退出。 */
function createTray() {
  if (tray !== null)
    return
  const iconFile = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', '..', 'build', 'icon.ico')
  const image = nativeImage.createFromPath(iconFile)
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('Bosom Friend')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Bosom Friend', click: () => focusMainWindow() },
    { type: 'separator' },
    { label: '完全退出（关闭所有进程）', click: () => void quitAndStop() },
  ]))
  // Windows 习惯：单击托盘图标即恢复窗口；双击同样生效。
  tray.on('click', () => focusMainWindow())
  tray.on('double-click', () => focusMainWindow())
}

/** 启动时校正桌面/开始菜单快捷方式图标：品牌 ico 走正式资源路径，升级重装后也不会变回旧图标。 */
function ensureShortcutIcon() {
  if (!app.isPackaged)
    return
  const iconPath = path.join(process.resourcesPath, 'icon.ico')
  if (!fs.existsSync(iconPath))
    return
  const shortcuts = [
    path.join(app.getPath('desktop'), 'Bosom Friend.lnk'),
    path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Bosom Friend.lnk'),
  ]
  for (const file of shortcuts) {
    if (!fs.existsSync(file)) continue
    const script = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${file}');$s.IconLocation='${iconPath},0';$s.Save()`
    try {
      require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 8000,
      }, () => {})
    } catch {
      // 无权限或路径不存在时跳过；不阻塞启动。
    }
  }
}

function createWindow() {
  // 低配笔记本（1366×768、或 125% 缩放）放不下 1440×900：按可用工作区夹取初始尺寸，
  // 否则窗口底部按钮会被裁到屏幕外；最小尺寸同步下调，避免小屏无法缩小。
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const windowWidth = Math.min(1440, workArea.width)
  const windowHeight = Math.min(900, workArea.height)
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: Math.min(1024, windowWidth),
    minHeight: Math.min(640, windowHeight),
    title: 'Bosom Friend',
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.ico')
      : path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  Menu.setApplicationMenu(null)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  mainWindow.on('close', (event) => {
    if (quitting)
      return
    event.preventDefault()
    // 关闭窗口 = 最小化到托盘，后台服务继续运行；完全退出走托盘菜单。
    mainWindow.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.setAppUserModelId('com.bosomfriend.desktop')

// 老集显/虚拟机里 GPU 进程崩溃会表现为白屏：连续两次崩溃后自动退回软件渲染，
// 崩溃事实同时写日志与留痕文件（不静默降级，也不阻塞启动）。
const gpuFallback = gpuFallbackReason()
if (gpuFallback !== '') {
  app.disableHardwareAcceleration()
  console.error('[GPU_FALLBACK] 已关闭硬件加速：' + gpuFallback)
}
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') return
  console.error('[GPU_CRASH] ' + details.reason)
  recordGpuCrash(details.reason)
})

let appIsStarted = false
function startApp() {
  if (appIsStarted)
    return
  appIsStarted = true
  app.on('second-instance', () => focusMainWindow())

  app.whenReady().then(() => {
    // 32 位 Windows：随包 Electron / Node / Python / Chromium 都是 64 位，本程序无法运行。
    // 提前给出可执行的说明，而不是让用户对着启动页干等。
    if (process.arch === 'ia32') {
      dialog.showMessageBoxSync({
        type: 'error',
        title: '无法启动 Bosom Friend',
        message: '当前系统是 32 位 Windows，本程序需要 64 位 Windows 10 / 11。',
        detail: '请在“设置 → 系统 → 关于”里确认“系统类型”为 64 位操作系统，再安装 64 位版本的 Bosom Friend。',
        buttons: ['退出'],
      })
      app.quit()
      return
    }
    createTray()
    ensureShortcutIcon()
    // 档位留痕：现场排查能直接看到"为什么被判成低配"，不必让用户报配置。
    writePerfProfile(app.getPath('userData'), { ...PERF, gpuFallback })
    // 硬件加速稳定运行 5 分钟（无 GPU 崩溃）即清除留痕，避免偶发崩溃永久降级。
    if (gpuFallback === '') {
      const stableTimer = setTimeout(() => clearGpuCrashMarker(), 5 * 60 * 1000)
      stableTimer.unref?.()
    }
    ipcMain.on('bosom-friend:version', (event) => {
      event.returnValue = app.getVersion()
    })
    ipcMain.handle('bosom-friend:quit', () => {
      void quitAndStop()
      return true
    })
    ipcMain.handle('bosom-friend:status', () => ({
      version: app.getVersion(),
      startedAt,
      managedChildPids: [...managedChildren.keys()],
    }))
    ipcMain.handle('bosom-kernel:status', () => ({
      version: app.getVersion(),
      startedAt,
      managedChildPids: [...managedChildren.keys()],
      handshake: lastHandshake,
      error: kernelError,
      attached: attachedNote,
      // 启动页用 getStatus 兜住订阅之前已经发生的里程碑，不必依赖事件时序。
      progress,
      // 启动进度留痕：用户报"卡在某一步"时，这里能看出走到过哪几步、各用了多久。
      progressLog,
      perf: {
        tier: PERF.tier,
        reasons: PERF.reasons,
        measured: PERF.measured,
        caps: PERF.caps,
        gpuSoftware: gpuFallback !== '',
        gpuReason: gpuFallback,
      },
    }))
    ipcMain.handle('bosom-kernel:retry', async () => {
      attachedNote = ''
      kernelError = ''
      if (kernelHost) {
        await kernelHost.close().catch(() => {})
        kernelHost = null
      }
      resetProgress()
      await startKernel()
      return { handshake: lastHandshake, error: kernelError, attached: attachedNote, progress, perf: { tier: PERF.tier, reasons: PERF.reasons } }
    })
    createWindow()
    void startKernel()
  })

  app.on('before-quit', (event) => {
    if (quitting)
      return
    event.preventDefault()
    void quitAndStop()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (gotSingleInstanceLock) {
  startApp()
}
else {
  // 前一个实例可能正在退出：短暂重试接管，避免用户在退出窗口期内双击被“无响应”挡住。
  let retries = 0
  const retryLock = () => {
    if (app.requestSingleInstanceLock()) {
      startApp()
      return
    }
    retries += 1
    if (retries >= 4) {
      app.quit()
      return
    }
    setTimeout(retryLock, 1000)
  }
  setTimeout(retryLock, 500)
}

// The shell intentionally does not launch any sidecar until a typed manifest is explicitly
// configured. Keep this file free of implicit process creation.