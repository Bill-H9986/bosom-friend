#!/usr/bin/env node
/**
 * 内核运行时兜底解压验收：工具阶梯、失败文案、真实解压与负向对照。
 *
 * 为什么要有它：现场（DEF-045）应用装完打不开，屏幕上只有一句 `spawn tar.exe ENOENT`。
 * 实测同一句话对应三种完全不同的原因——系统没有 tar.exe、tar.exe 不在进程 PATH 上、
 * 进程当前目录不存在——所以这里把"选谁解压、失败说什么"钉成可判定的边界值，
 * 并用真进程做正负对照，而不是只看"本机跑起来没崩"。
 *
 * DEF-045 的修法（tar 绝对路径 + 随包 Python）在 0.2.47 现场**又失败了一次**：这台机器没有
 * System32\tar.exe，随包 Python 报 `Command failed`。根因是长路径——这份 zip 最深相对路径
 * 233 字符，解到 %APPDATA% 之后超过 MAX_PATH 260，而 Windows 的长路径支持默认关闭，
 * Python 的 zipfile 与 libuv 都过不去。所以本探针还钉住两件事：
 *   1. 阶梯里有"自带解压器 kernel-unzip.cjs"这一保底，且它自己构造 \\?\ 前缀；
 *   2. 失败文案必须带**真实原因**（DEF-055：以前只留 execFile 的首行＝一整行命令行）。
 *
 * 用法：
 *   node products/bosom-friend/qa/probes/verify-kernel-extract.mjs             # 门禁用，秒级
 *   node products/bosom-friend/qa/probes/verify-kernel-extract.mjs --real-zip  # 真解 385MB 内核 zip（几分钟）
 * 退出码：0 = 全部通过；1 = 存在失败断言。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(dirname(HERE))
const require = createRequire(import.meta.url)
const extract = require(join(PRODUCT, 'desktop', 'electron', 'kernel-extract.cjs'))
const unzip = require(join(PRODUCT, 'desktop', 'electron', 'kernel-unzip.cjs'))

const {
  systemTarPath,
  portablePythonPath,
  kernelRuntimeReady,
  buildExtractPlan,
  failureReason,
  describeExtractFailure,
  runExtractPlan,
} = extract

const checks = []
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''))
}

const zip = 'C:\\pkgs\\kernel-runtime.zip'
const target = 'C:\\users\\u\\kernel-runtime'
const nodeStep = { command: 'C:\\app\\Bosom Friend.exe', script: 'C:\\app\\resources\\kernel-unzip.cjs', env: { ELECTRON_RUN_AS_NODE: '1' } }
const both = () => true
const sources = plan => plan.map(step => step.source).join(' > ')

// ---- 工具阶梯：优先级、绝对路径、参数形态 ----
const full = buildExtractPlan({ zip, target, env: { SystemRoot: 'C:\\Windows' }, resourcesPath: 'C:\\app\\resources', exists: both, node: nodeStep })
record('阶梯顺序：系统 tar → PATH tar → 自带解压器 → 随包 Python',
  sources(full) === 'system32-tar > path-tar > app-node > portable-python',
  sources(full))
record('系统 tar 走绝对路径，不靠 PATH 解析',
  full[0].command === 'C:\\Windows\\System32\\tar.exe',
  full[0].command)
record('取不到 SystemRoot 时退回 C:\\Windows',
  buildExtractPlan({ zip, target, env: {}, resourcesPath: 'C:\\app\\resources', exists: both })[0].command === 'C:\\Windows\\System32\\tar.exe',
  buildExtractPlan({ zip, target, env: {}, resourcesPath: 'C:\\app\\resources', exists: both })[0].command)
record('SystemRoot 在别的盘符也跟得上',
  buildExtractPlan({ zip, target, env: { SystemRoot: 'D:\\Windows' }, resourcesPath: 'C:\\app\\resources', exists: both })[0].command === 'D:\\Windows\\System32\\tar.exe',
  buildExtractPlan({ zip, target, env: { SystemRoot: 'D:\\Windows' }, resourcesPath: 'C:\\app\\resources', exists: both })[0].command)
record('随包 Python 用绝对路径 + zipfile -e',
  full[3].command === portablePythonPath('C:\\app\\resources') && full[3].args.join(' ') === '-m zipfile -e ' + zip + ' ' + target,
  full[3].command + ' ' + full[3].args.join(' '))
record('tar 参数把 zip 与目标目录都带上',
  full[0].args.join(' ') === '-xf ' + zip + ' -C ' + target,
  full[0].args.join(' '))

// 长路径没开的机器（Windows 默认值）上 tar 系列必失败：保底要排在前面，别让用户白等。
const noLongPaths = buildExtractPlan({ zip, target, env: { SystemRoot: 'C:\\Windows' }, resourcesPath: 'C:\\app\\resources', exists: both, node: nodeStep, longPathsEnabled: false })
record('探测到没开长路径时，自带解压器排在最前（tar 必失败，不排前面）',
  sources(noLongPaths) === 'app-node > portable-python > system32-tar > path-tar',
  sources(noLongPaths))
record('自带解压器命令＝脚本 + zip + 目标目录，并带上 ELECTRON_RUN_AS_NODE',
  full[2].command === nodeStep.command
  && full[2].args.join(' ') === nodeStep.script + ' ' + zip + ' ' + target
  && full[2].env.ELECTRON_RUN_AS_NODE === '1',
  full[2].args.join(' '))

const noSystemTar = buildExtractPlan({ zip, target, env: { SystemRoot: 'C:\\Windows' }, resourcesPath: 'C:\\app\\resources', exists: p => String(p).includes('python.exe') })
record('系统没有 tar 时仍尝试第三方 tar，并保留随包 Python',
  sources(noSystemTar) === 'path-tar > portable-python',
  sources(noSystemTar))

const noPython = buildExtractPlan({ zip, target, env: { SystemRoot: 'C:\\Windows' }, resourcesPath: 'C:\\app\\resources', exists: p => String(p).includes('tar.exe') })
record('随包 Python 缺失时不硬塞进计划',
  sources(noPython) === 'system32-tar > path-tar',
  sources(noPython))

// ---- 失败文案：说清缺什么 + 下一步做什么，且不把 libuv 原文甩给用户 ----
const enoent = Object.assign(new Error('spawn tar.exe ENOENT'), { code: 'ENOENT' })
const missing = describeExtractFailure([
  { source: 'system32-tar', error: enoent },
  { source: 'path-tar', error: enoent },
  { source: 'portable-python', error: enoent },
])
record('三种工具都缺时说清缺什么',
  missing.includes('缺少解压组件') && missing.includes('随包 Python'),
  missing)
record('失败文案给出可执行动作',
  missing.includes('重新运行安装包完成修复安装') && missing.includes('BosomFriend-Setup'),
  missing)
record('失败文案里没有 libuv 原文',
  !missing.includes('ENOENT') && !missing.includes('spawn') && !missing.includes('\\\\'),
  missing)
record('空计划也有可读原因',
  describeExtractFailure([]).includes('重新运行安装包'),
  describeExtractFailure([]))

const exited = Object.assign(new Error('tar.exe: Error opening archive: Cannot open 系统找不到指定的文件'), { code: 1 })
const tarFailed = describeExtractFailure([{ source: 'system32-tar', error: exited }])
record('真实解压失败保留原因首行并指向重装',
  tarFailed.includes('系统自带 tar.exe') && tarFailed.includes('Error opening archive') && tarFailed.includes('重新运行安装包'),
  tarFailed)
const multiLine = describeExtractFailure([{ source: 'path-tar', error: new Error('第一行原因' + String.fromCharCode(10) + '第二行栈') }])
record('多行错误只取首行（不带调用栈）',
  multiLine.includes('第一行原因') && !multiLine.includes('第二行栈'),
  multiLine)

// ---- DEF-055：失败文案必须带 execFile 的真实原因，而不是一整行命令行 ----
const pythonFailure = Object.assign(
  new Error('Command failed: C:\\app\\resources\\engine\\python-base\\python.exe -m zipfile -e C:\\pkgs\\kernel-runtime.zip C:\\users\\u\\kernel-runtime-0.2.47' + String.fromCharCode(10)
    + 'Traceback (most recent call last):' + String.fromCharCode(10)
    + '  File "zipfile.py", line 1710, in extractall' + String.fromCharCode(10)
    + "FileNotFoundError: [WinError 3] 系统找不到指定的路径。: 'C:\\\\Users\\\\u\\\\AppData\\\\Roaming\\\\Bosom Friend\\\\kernel-runtime-0.2.47\\\\node_modules'" + String.fromCharCode(10)),
  { code: 1, stderr: 'Traceback (most recent call last):' + String.fromCharCode(10) + '  File "zipfile.py", line 1710, in extractall' + String.fromCharCode(10) + "FileNotFoundError: [WinError 3] 系统找不到指定的路径。" },
)
record('Python 失败时取 stderr 末行（真实原因），不是首行命令行',
  failureReason(pythonFailure) === 'FileNotFoundError: [WinError 3] 系统找不到指定的路径。',
  String(failureReason(pythonFailure)))
const pythonMessage = describeExtractFailure([{ source: 'portable-python', error: pythonFailure }])
record('失败文案里出现 FileNotFoundError（0.2.47 现场缺的就是这句）',
  pythonMessage.includes('FileNotFoundError') && pythonMessage.includes('随包 Python'),
  pythonMessage.slice(0, 160))
record('ENOENT 仍按"缺少组件"表述，不当成原因抛给用户',
  failureReason(enoent) === null,
  String(failureReason(enoent)))

// ---- 校验语义：解压命令成功但入口没出现，不算成功 ----
const dir = mkdtempSync(join(tmpdir(), 'bf-kernel-extract-'))
mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
writeFileSync(join(dir, 'src', 'nested', 'hello.txt'), 'bosom-friend')
const realZip = join(dir, 'small.zip')
const realOut = join(dir, 'out')
mkdirSync(realOut)
let planSource = ''
try {
  execFileSync(systemTarPath(process.env), ['-a', '-c', '-f', realZip, '-C', join(dir, 'src'), '.'])
  const plan = buildExtractPlan({ zip: realZip, target: realOut, env: process.env, resourcesPath: join(dir, 'no-engine'), exists: existsSync })
  planSource = await runExtractPlan(plan, { cwd: dir, timeoutMs: 60000 })
}
catch (error) {
  planSource = 'ERROR ' + error.message
}
let extracted = null
try {
  extracted = readFileSync(join(realOut, 'nested', 'hello.txt'), 'utf8')
}
catch {
  // 读不到就是没解开，下面按失败判定
}
record('真实解压走产品同一条路径并落到目标目录', extracted === 'bosom-friend', 'source=' + planSource + ' content=' + String(extracted))

let verifyCalls = 0
const verifyPlan = [
  { source: 'first', command: process.execPath, args: ['-e', 'process.exit(0)'] },
  { source: 'second', command: process.execPath, args: ['-e', 'process.exit(0)'] },
]
let verifySource = ''
try {
  verifySource = await runExtractPlan(verifyPlan, { cwd: dir, timeoutMs: 20000, verify: () => { verifyCalls += 1; return verifyCalls > 1 } })
}
catch (error) {
  verifySource = 'ERROR ' + error.message
}
record('解压命令返回 0 但入口没出现时不算成功，继续下一步',
  verifySource === 'second' && verifyCalls === 2,
  'source=' + verifySource + ' verifyCalls=' + verifyCalls)

let runtimeMarker = ''
try {
  mkdirSync(join(dir, 'rt', 'runtime'), { recursive: true })
  runtimeMarker = String(kernelRuntimeReady(join(dir, 'rt')))
  writeFileSync(join(dir, 'rt', 'runtime', 'bin-desktop.mjs'), '// stub')
}
catch (error) {
  runtimeMarker = 'ERROR ' + error.message
}
record('运行时就绪判据是 runtime/bin-desktop.mjs',
  runtimeMarker === 'false' && kernelRuntimeReady(join(dir, 'rt')) === true,
  'before=' + runtimeMarker + ' after=' + kernelRuntimeReady(join(dir, 'rt')))

// ---- 负向对照（真进程）：工具不存在时抛的是人话，不是 ENOENT ----
let negative = null
try {
  await runExtractPlan([{ source: 'path-tar', command: 'bf-no-such-tar-9f3a.exe', args: [] }], { cwd: dir, timeoutMs: 20000 })
  negative = 'DID-NOT-THROW'
}
catch (error) {
  negative = error.message
}
record('真进程 ENOENT 被转成人话',
  negative !== 'DID-NOT-THROW' && negative.includes('缺少解压组件') && !negative.includes('ENOENT'),
  negative)

// ---- 自带解压器：真解一条超过 MAX_PATH 的路径（0.2.47 现场失败的那类条目）----
/**
 * 造一个"只存不压"的极小 zip：探针要验的是长路径与解压语义，不需要引入压缩库依赖。
 *
 * @param entries - `[{ name, data }]`。
 * @returns zip 文件内容。
 */
function buildStoredZip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(entry.data.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, entry.data)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt32LE(checksum, 16)
    record.writeUInt32LE(entry.data.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += header.length + name.length + entry.data.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

const deepName = 'deep/' + Array.from({ length: 20 }, (_, index) => 'd' + String(index).padStart(2, '0') + '-' + 'x'.repeat(6)).join('/') + '/file.txt'
record('探针的深路径夹具本身超过 MAX_PATH（否则这条验收没有意义）',
  deepName.length > 200 && join(dir, deepName).length > 260,
  'entry=' + deepName.length + ' absolute=' + join(dir, deepName).length)

const deepZip = join(dir, 'deep.zip')
writeFileSync(deepZip, buildStoredZip([{ name: deepName, data: Buffer.from('deep-ok') }, { name: 'shallow.txt', data: Buffer.from('shallow-ok') }]))
const deepOut = join(dir, 'deep-out')
let deepResult = null
let deepError = ''
try {
  deepResult = await unzip.extractZipFile(deepZip, deepOut)
}
catch (error) {
  deepError = error.message
}
let deepContent = null
try {
  deepContent = readFileSync(unzip.toLongPath(join(deepOut, deepName)), 'utf8')
}
catch {
  // 读不到就是没解出来
}
record('自带解压器能解出超过 MAX_PATH 260 的条目',
  deepContent === 'deep-ok',
  'files=' + (deepResult?.files ?? 'ERR') + ' deepest=' + (deepResult?.deepest ?? '-') + ' err=' + deepError)
record('自带解压器给超长路径加 \\\\?\\ 前缀（不依赖系统长路径开关）',
  unzip.toLongPath(join(deepOut, deepName)).startsWith('\\\\?\\') && unzip.toLongPath(join(deepOut, 'short.txt')) === join(deepOut, 'short.txt'),
  unzip.toLongPath(join(deepOut, deepName)).slice(0, 40) + '…')
record('自带解压器挡住 zip-slip',
  (() => {
    try {
      unzip.resolveEntryPath(deepOut, '../escape.txt')
      return false
    }
    catch {
      return true
    }
  })(), 'resolveEntryPath(../escape.txt)')

const corruptZip = join(dir, 'corrupt.zip')
writeFileSync(corruptZip, Buffer.from('not-a-zip-at-all'))
let corruptReason = ''
try {
  await unzip.extractZipFile(corruptZip, join(dir, 'corrupt-out'))
  corruptReason = 'DID-NOT-THROW'
}
catch (error) {
  corruptReason = error.message
}
record('自带解压器对损坏的 zip 给出可读原因',
  corruptReason.includes('不是有效的 ZIP'),
  corruptReason)

// ---- 自带解压器 CLI：安装器与现场修复脚本用的就是这条命令行契约 ----
const cliOut = join(dir, 'cli-out')
let cliStdout = ''
let cliStatus = 0
try {
  cliStdout = execFileSync(process.execPath, [join(PRODUCT, 'desktop', 'electron', 'kernel-unzip.cjs'), deepZip, cliOut], { encoding: 'utf8' })
}
catch (error) {
  cliStatus = error.status ?? -1
  cliStdout = String(error.stdout ?? '') + String(error.stderr ?? '')
}
record('CLI 解压成功并打印 UNZIP_PROGRESS / UNZIP_OK（安装器与进度条都靠它）',
  cliStatus === 0 && cliStdout.includes('UNZIP_PROGRESS ') && cliStdout.includes('UNZIP_OK files=2'),
  'exit=' + cliStatus + ' out=' + cliStdout.trim().split(String.fromCharCode(10)).slice(-1)[0])

let cliFailStatus = 0
let cliFailStderr = ''
try {
  execFileSync(process.execPath, [join(PRODUCT, 'desktop', 'electron', 'kernel-unzip.cjs'), corruptZip, join(dir, 'cli-bad')], { encoding: 'utf8' })
}
catch (error) {
  cliFailStatus = error.status ?? -1
  cliFailStderr = String(error.stderr ?? '')
}
record('CLI 解压失败时非零退出并打印 UNZIP_FAIL（安装器据此换下一步）',
  cliFailStatus === 1 && cliFailStderr.includes('UNZIP_FAIL'),
  'exit=' + cliFailStatus + ' stderr=' + cliFailStderr.trim().slice(0, 120))

rmSync(dir, { recursive: true, force: true })

// ---- 结构不变量：主进程与安装器必须同阶梯，且都不再裸名 spawn ----
const mainSrc = readFileSync(join(PRODUCT, 'desktop', 'electron', 'main.cjs'), 'utf8')
record('主进程不再裸名 spawn tar.exe',
  !/execFile\(\s*'tar\.exe'/.test(mainSrc),
  (mainSrc.match(/execFile\(\s*'tar\.exe'/) ?? ['(无)'])[0])
record('主进程解压时显式给 cwd（无效 cwd 也报 ENOENT）',
  /cwd:\s*path\.dirname\(zip\)/.test(mainSrc),
  (mainSrc.match(/cwd:\s*path\.dirname\(zip\)/) ?? ['(未找到)'])[0])
record('主进程通过 kernel-extract 模块选工具',
  mainSrc.includes("require('./kernel-extract.cjs')") && mainSrc.includes('runExtractPlan'),
  'kernel-extract.cjs')
record('主进程传入自带解压器与长路径探测结果',
  mainSrc.includes('probeLongPaths') && mainSrc.includes('kernelUnzipScript') && mainSrc.includes('nodeUnzipCommand'),
  'probeLongPaths / kernelUnzipScript / nodeUnzipCommand')
record('主进程把失败原因写进诊断日志（DEF-055）',
  mainSrc.includes('writeExtractLog') && mainSrc.includes('failureReason'),
  'writeExtractLog')

const nshSrc = readFileSync(join(PRODUCT, 'desktop', 'build', 'installer.nsh'), 'utf8')
record('安装器先看 tar 是否真的在',
  nshSrc.includes('IfFileExists "$SYSDIR\\tar.exe"'),
  'IfFileExists $SYSDIR\\tar.exe')
record('安装器在 Python 之前用自带解压器（长路径唯一走得通的一条）',
  nshSrc.includes('"$INSTDIR\\resources\\runtime\\node.exe" "$INSTDIR\\resources\\kernel-unzip.cjs"')
  && nshSrc.indexOf('kernel-unzip.cjs') < nshSrc.indexOf('python-base\\python.exe" -m zipfile -e'),
  'built-in unpacker before python')
record('安装器顺手打开 Windows 长路径支持（一次 UAC，静默安装跳过）',
  nshSrc.includes('LongPathsEnabled') && nshSrc.includes('ExecShell "runas"') && nshSrc.includes('IfSilent bf_longpaths_silent'),
  'installer.nsh long path block')
record('长路径这一步不接受"命令跑过就算成功"：轮询注册表直到真读到 1，超时走如实的拒绝分支',
  nshSrc.includes('bf_longpaths_wait') && nshSrc.includes('bf_longpaths_denied') && nshSrc.includes('Long path support was NOT enabled'),
  'poll + denied branch')
record('安装器解压失败不再静默（有可见提示 + 保留 zip 的说明）',
  nshSrc.includes('MessageBox MB_ICONEXCLAMATION') && nshSrc.includes('kernel-runtime.zip in the install folder'),
  'MessageBox MB_ICONEXCLAMATION')

const builderSrc = readFileSync(join(PRODUCT, 'desktop', 'electron-builder.yml'), 'utf8')
record('打包时把自带解压器放到 resources 根（安装器读不到 asar）',
  /from:\s*electron\/kernel-unzip\.cjs/.test(builderSrc) && /to:\s*kernel-unzip\.cjs/.test(builderSrc),
  'extraResources kernel-unzip.cjs')
// 真正出包跑的是 build-win.sh，它**自己生成** electron-builder.yml（不读上面那份静态配置）：
// 只改静态配置会在"探针绿 + 装出来的包没有解压器"之间留一条缝。
const buildShSrc = readFileSync(join(PRODUCT, 'desktop', 'build-win.sh'), 'utf8')
record('出包脚本 build-win.sh 生成的配置也带上自带解压器',
  /to: kernel-unzip\.cjs/.test(buildShSrc) && buildShSrc.includes('kernel-unzip.cjs'),
  'build-win.sh extraResources')

// ---- 现场修复包（qa/repair-kit + make-repair-kit.ps1）：那台机器进不去，只能靠双击修复包 ----
const kitDir = join(PRODUCT, 'qa', 'repair-kit')
const kitCmd = readdirSync(kitDir).filter(name => name.toLowerCase().endsWith('.cmd'))
record('修复包里有双击入口（.cmd）与中文说明',
  kitCmd.length === 1 && readdirSync(kitDir).some(name => name.endsWith('.txt')),
  readdirSync(kitDir).join(', '))
record('修复包入口 .cmd 是纯 ASCII（cmd.exe 按 OEM 代码页读文件，中文路径写进去会找不到文件）',
  kitCmd.length === 1 && /^[\x00-\x7F]*$/.test(readFileSync(join(kitDir, kitCmd[0]), 'latin1')),
  kitCmd[0] ?? '(缺失)')
const runRepairSrc = readFileSync(join(kitDir, 'run-repair.ps1'), 'utf8')
record('修复包入口做两件事：提权开长路径 + 调用阶梯脚本',
  runRepairSrc.includes('LongPathsEnabled') && runRepairSrc.includes('& $ladder -AppDir'),
  'A=LongPathsEnabled, B=& $ladder -AppDir')
record('修复包入口不再用数组 splat 传参（会被按位置绑定，"安装目录"变成字符串 -AppDir）',
  !runRepairSrc.includes('@ladderArgs'),
  runRepairSrc.includes('@ladderArgs') ? '仍在使用 @ladderArgs' : '已改为具名传参')
const kitMakerSrc = readFileSync(join(PRODUCT, 'qa', 'make-repair-kit.ps1'), 'utf8')
record('修复包由脚本生成，阶梯与解压器都是仓库里的同一份（不复制代码）',
  kitMakerSrc.includes("repair-kernel-runtime.ps1") && kitMakerSrc.includes("kernel-unzip.cjs") && kitMakerSrc.includes("qa\\repair-kit"),
  'make-repair-kit.ps1')

// ---- 可选：真解 385MB 内核 zip（--real-zip，几分钟；门禁不跑这一条）----
if (process.argv.includes('--real-zip')) {
  const realKernelZip = join(PRODUCT, 'desktop', 'dist', 'kernel-runtime.zip')
  if (!existsSync(realKernelZip)) {
    record('真内核 zip 解压（--real-zip）', false, '缺少 ' + realKernelZip)
  }
  else {
    const realOut = mkdtempSync(join(tmpdir(), 'bf-kernel-real-'))
    const startedAt = Date.now()
    let summary = ''
    let ok = false
    try {
      const result = await unzip.extractZipFile(realKernelZip, realOut, {
        onProgress: progress => {
          if (progress.written % 20000 === 0) console.log('  … ' + progress.written + '/' + progress.total)
        },
      })
      ok = result.files === result.total
        && result.files > 100000
        && kernelRuntimeReady(realOut)
        && readFileSync(unzip.toLongPath(join(realOut, result.deepestName)), 'utf8').length > 0
      summary = 'files=' + result.files + ' deepest=' + result.deepest + ' ms=' + (Date.now() - startedAt)
    }
    catch (error) {
      summary = 'ERROR ' + error.message
    }
    record('真内核 zip 解压（--real-zip）：条目数一致 + 入口在位 + 最深条目可读', ok, summary)
    rmSync(realOut, { recursive: true, force: true })
  }
}

const failed = checks.filter(check => !check.ok)
console.log('KERNEL_EXTRACT ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
