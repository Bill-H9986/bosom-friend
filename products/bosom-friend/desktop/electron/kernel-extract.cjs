/**
 * 内核运行时兜底解压：解压工具的选择阶梯与失败文案。
 *
 * 单独成模块的原因：解压工具选谁，是"应用装不装得上"的唯一分叉点，必须能用边界值直接验收
 * （与 perf-profile.cjs 的 classifyMachine 同一做法）。现场（DEF-045）在 Windows 11 + Node 24
 * 上实测：下面三种情况都会得到**同一句** `spawn tar.exe ENOENT`——
 *   1. 系统里没有 tar.exe（1803 以前的 Win10、精简/ghost 镜像、被"系统瘦身"工具删过）；
 *   2. tar.exe 就在 System32 里，但进程的 PATH 里没有 System32（libuv 不做系统目录兜底）；
 *   3. 进程当前目录不存在（Node 在 Windows 上把无效 cwd 也报成同一个 ENOENT）。
 * 因此这里既不靠 PATH 解析，也不假设"系统一定有 tar"：绝对路径 → PATH → 自带解压器 → 随包便携 Python。
 *
 * **为什么必须有自带解压器（kernel-unzip.cjs）**：0.2.47 在 4 核 / 7.9GB 现场复现了同一处的
 * 第二次失败——PATH 上的 tar.exe ENOENT，随包 Python 报 `Command failed`。原因是这份 zip
 * 的最深相对路径 233 字符，解到 `%APPDATA%\Bosom Friend\kernel-runtime` 之后超过 MAX_PATH 260，
 * 而 Windows 的长路径支持默认关闭：Python 的 zipfile 与 libuv 都只在
 * "进程 longPathAware **且** 注册表 LongPathsEnabled=1"时才越过 260。只有自带解压器显式构造
 * \\?\ 前缀，不依赖这两条中的任何一条。
 *
 * 随包 Python（resources/engine/python-base/python.exe）仍留在阶梯末端：它是唯一在
 * "自带解压器文件缺失"时还能自救的路径，但**不能**当成保底（长路径没开的机器上它必失败）。
 */
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

/** 失败后给用户的下一步动作，与 DEF-040 的文案同一口径（说得出口、做得出来）。 */
const REPAIR_ACTION = '请重新运行安装包完成修复安装（BosomFriend-Setup-*.exe），再打开本程序'

/** 尝试来源的中文名，用于拼面向用户的失败原因。 */
const SOURCE_LABELS = {
  'system32-tar': '系统自带 tar.exe',
  'path-tar': 'PATH 上的 tar.exe',
  'app-node': '应用自带解压器',
  'portable-python': '随包 Python',
}

/** 内核运行时入口；解压完必须能在目标目录里看到它，否则这次解压不算成功。 */
const RUNTIME_MARKER = path.join('runtime', 'bin-desktop.mjs')

/** 系统自带 tar.exe 的绝对路径（Windows 10 1803 起随系统提供）。 */
function systemTarPath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'tar.exe')
}

/** 随包便携 Python 的绝对路径；相对 resources 目录。 */
function portablePythonPath(resourcesPath) {
  return path.join(resourcesPath, 'engine', 'python-base', 'python.exe')
}

/**
 * 内置运行时入口是否存在。
 *
 * 判据只认入口文件：解压工具可能"退出码 0 但什么都没解出来"（长路径被截断、磁盘写满、
 * 杀软拦掉一半文件），只看到退出码就当成功，用户会在下一步收到一个和这里无关的错误。
 *
 * @param target - 内核运行时目标目录。
 * @returns 入口文件是否存在。
 */
function kernelRuntimeReady(target) {
  return fs.existsSync(path.join(target, RUNTIME_MARKER))
}

/**
 * 按优先级给出解压尝试序列。
 *
 * PATH 上的 tar.exe 无法预先判定存在性（是否可执行只有 spawn 了才知道），所以它总是排在
 * 绝对路径之后：在没有 tar 的机器上它会立刻 ENOENT，代价是一次几毫秒的 spawn 失败，
 * 换来的是"第三方 tar（Git/msys）装在 PATH 上"这类机器也能修好。
 *
 * 自带解压器（app-node）与随包 Python 是**保底**：只有它们能绕过 MAX_PATH。
 * 长路径支持没开的机器（Windows 默认值）上 tar 系列必然失败，此时把保底提到最前，
 * 不让用户白等一次注定失败的 tar——顺序由 `longPathsEnabled` 显式决定，不靠猜。
 *
 * @param input - `zip`/`target` 绝对路径、`env`、`resourcesPath`、可选的 `exists`、
 *   `longPathsEnabled`（false = 明确探测到本机没开长路径），以及 `node`
 *   （`{ command, script, env }`，命令跑 `script zip target`）。
 * @returns 尝试序列，每项为 `{ source, command, args, env? }`，按优先级排列。
 */
function buildExtractPlan(input) {
  const exists = input.exists ?? fs.existsSync
  const fast = []
  const guaranteed = []
  const tar = systemTarPath(input.env)
  if (exists(tar)) {
    fast.push({ source: 'system32-tar', command: tar, args: ['-xf', input.zip, '-C', input.target] })
  }
  fast.push({ source: 'path-tar', command: 'tar.exe', args: ['-xf', input.zip, '-C', input.target] })
  if (input.node) {
    guaranteed.push({
      source: 'app-node',
      command: input.node.command,
      args: [input.node.script, input.zip, input.target],
      env: input.node.env,
    })
  }
  const python = portablePythonPath(input.resourcesPath)
  if (exists(python)) {
    guaranteed.push({ source: 'portable-python', command: python, args: ['-m', 'zipfile', '-e', input.zip, input.target] })
  }
  return input.longPathsEnabled === false ? [...guaranteed, ...fast] : [...fast, ...guaranteed]
}

/** 取错误首行：多行错误里只有首行是原因，其余是调用栈。 */
function firstLine(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return raw.split(/\r?\n/)[0].trim() || '未知原因'
}

/**
 * 取一条失败尝试里**真正的原因**。
 *
 * execFile 的失败消息形如 `Command failed: <完整命令行>\n<stderr>`：首行只有命令行，
 * 真正的原因（Python 的 `FileNotFoundError: [WinError 3] ...`、tar 的 `Cannot open ...`）
 * 在后续行里。0.2.47 现场的错误框只留了首行，于是"随包 Python 失败"后面跟的是一整行
 * 命令行——用户和排查的人都拿不到任何可用信息（DEF-055）。这里改成优先取 stderr 的最后
 * 一行非空内容：异常的落点就在最后一行。
 *
 * @param error - 一次尝试抛出的错误。
 * @returns 可读原因；ENOENT（工具不存在）返回 null，由调用方按"缺少解压组件"统一表述。
 */
function failureReason(error) {
  if (error === null || error === undefined) return '未知原因'
  if (typeof error === 'object' && error.code === 'ENOENT') return null
  const stderr = typeof error.stderr === 'string' ? error.stderr : ''
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  if (lines.length > 0) return lines[lines.length - 1].slice(0, 200)
  return firstLine(error).slice(0, 200)
}

/**
 * 面向普通用户的解压失败原因。
 *
 * 不把 libuv 原文（`spawn tar.exe ENOENT`）甩给用户：那句话既不说清"缺什么"，也不给"怎么办"，
 * 用户能做的只有重装或者放弃（DEF-045 的现场表现）。但**必须**保留真实原因（DEF-055）：
 * 只说"随包 Python 失败了"等于什么也没说。
 *
 * @param failures - 每次尝试的 `{ source, error }`；空数组表示没有任何可尝试的工具。
 * @returns 一句话失败原因，末尾带可执行动作。
 */
function describeExtractFailure(failures) {
  const list = Array.isArray(failures) ? failures : []
  if (list.length === 0) return '本机没有可用的解压组件，无法展开内核运行时：' + REPAIR_ACTION
  if (list.every(item => item.error !== null && item.error !== undefined && item.error.code === 'ENOENT')) {
    return '本机缺少解压组件（系统 tar.exe 与随包 Python 都不可用），无法展开内核运行时：' + REPAIR_ACTION
  }
  const reasons = list.map(item => {
    const label = SOURCE_LABELS[item.source] ?? String(item.source)
    return label + ' 失败（' + (failureReason(item.error) ?? '程序不存在') + '）'
  })
  return '内核运行时解压失败（' + reasons.join('；') + '）：' + REPAIR_ACTION
}

/**
 * 执行一条解压尝试。
 *
 * cwd 必须由调用方显式给出：Node 在 Windows 上把"进程当前目录不存在"也报成
 * `spawn ... ENOENT`，与"找不到这个程序"无法区分；给 zip 所在目录最稳（上一行刚读过它）。
 *
 * @param step - `{ command, args, env? }` 尝试。
 * @param options - `cwd`、`timeoutMs`，以及可选的 `onChild`（把子进程交给调用方托管，退出时统一清理）。
 * @returns 子进程退出码为 0 时 resolve，否则 reject 该错误。
 */
function runExtractStep(step, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(step.command, step.args, {
      cwd: options.cwd,
      env: step.env ? { ...process.env, ...step.env } : undefined,
      windowsHide: true,
      timeout: options.timeoutMs ?? 30 * 60 * 1000,
    }, (error) => {
      if (error) reject(error)
      else resolve()
    })
    if (typeof options.onChild === 'function') options.onChild(child)
  })
}

/**
 * 按优先级跑完整个解压计划，全部失败时抛出面向用户的失败原因。
 *
 * 每一步都以 `options.verify` 判定成败，而不是只看退出码：解压工具报 0、运行时入口却不在
 * 的记录在 0.2.47 现场是真实存在的失败形态（长路径被截断时工具往往只警告不报错）。
 *
 * @param plan - {@link buildExtractPlan} 的结果。
 * @param options - `cwd`、`timeoutMs`、可选的 `onAttempt(step)`、`onChild(child)` 与
 *   `verify()`（抛错或返回 false 视为这一步没成功）。抛出的错误带 `failures` 数组（每一步的来源与真实原因），
 *   供调用方写诊断日志。
 * @returns 第一条成功且通过校验的尝试来源；全部失败则抛出 {@link describeExtractFailure} 的错误。
 */
async function runExtractPlan(plan, options) {
  const failures = []
  for (const step of plan) {
    if (typeof options.onAttempt === 'function') options.onAttempt(step)
    try {
      await runExtractStep(step, options)
      if (typeof options.verify === 'function' && options.verify() === false) {
        throw new Error('解压命令返回成功，但内核运行时入口没有出现（可能是长路径被截断或磁盘写满）')
      }
      return step.source
    }
    catch (error) {
      failures.push({ source: step.source, error })
    }
  }
  const error = new Error(describeExtractFailure(failures))
  // 结构化留痕：错误框只放一句话（脱敏 + 截断），完整原因由调用方写进诊断日志供现场排查。
  error.failures = failures.map(item => ({ source: item.source, reason: failureReason(item.error), code: item.error?.code ?? '' }))
  throw error
}

module.exports = {
  REPAIR_ACTION,
  RUNTIME_MARKER,
  SOURCE_LABELS,
  systemTarPath,
  portablePythonPath,
  kernelRuntimeReady,
  buildExtractPlan,
  failureReason,
  describeExtractFailure,
  runExtractStep,
  runExtractPlan,
}
