#!/usr/bin/env node
/**
 * 长视频端到端对账的**一条命令**：起一个隔离实例（独立数据根 + 独立端口 + 时长下限调小），
 * 跑 qa/probes/verify-long-video-e2e.mjs，跑完收掉实例，退出码就是探针的结论。
 *
 * 为什么要隔离实例而不是用开发实例：
 *   1. 产品默认时长下限 90 秒（BF_LONG_VIDEO_MIN_SECONDS），12 秒档会被抬到 90 秒——
 *      那是 18 镜、几十分钟与十几倍额度；隔离实例把下限设成目标档位，验的是**同一套编排**；
 *   2. 真机对账会往生成记录里写一条片并花真额度，不该污染用户自己的数据根；
 *   3. 跑完的成片、逐镜文件与字幕 ASS 留在隔离根里，随时能复查。
 *
 * 凭据与模型配置**照抄**真实数据根（settings.yaml / .credentials.yaml / llm-user.json / 形象库），
 * 只有数据与产物是新的——所以这条链路验的仍是用户配的那家厂商、那个模型。
 *
 * 起实例前会先 `pnpm --filter ...-server --filter ...-kernel build` 并把 lib 覆盖到 node_modules/.pnpm
 * 的注入副本上（与 launcher/scripts/dev-web.ps1 同一套动作）：运行时加载的是 lib 不是 src，
 * 少这一步实例跑的就是旧代码（2026-09-23 实测：走动 VLOG 在实例里不存在）。
 *
 * 用法：node products/bosom-friend/qa/probes/run-isolated-long-video.mjs [--port 31520] [--seconds 12] [--keep] [--no-run] [--clean]
 *    --keep   跑完不收实例（留着手动点页面）
 *    --no-run 只起实例，不跑探针（等价于起好之后自己再跑探针）
 *    --clean  跑完删掉隔离数据根（默认保留，作为证据）
 * 退出码：探针的退出码（0 通过 / 1 判红 / 2 跳过）；实例起不来时 3。
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const argValue = name => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const PORT = Number(argValue('--port') ?? process.env.BF_LV_E2E_PORT ?? 31520)
const SECONDS = Math.max(4, Number(argValue('--seconds') ?? process.env.BF_LV_SECONDS ?? 12) || 12)
const KEEP = args.includes('--keep')
const CLEAN = args.includes('--clean')
const RUN_PROBE = !args.includes('--no-run')
const SOURCE_HOME = (process.env.BF_DSH_HOME ?? '').trim() !== '' ? process.env.BF_DSH_HOME.trim() : join(homedir(), '.bosom-friend')
const ROOT = join(REPO, '.dsh-build', 'lv-e2e-home')
const DATA_ROOT = join(ROOT, 'bosom-friend')
const UPLOADS = join(DATA_ROOT, 'uploads')
const ORIGIN = 'http://127.0.0.1:' + String(PORT)
const LOG_OUT = join(REPO, '.dsh-build', 'lv-e2e-' + String(PORT) + '.out.log')
const LOG_ERR = join(REPO, '.dsh-build', 'lv-e2e-' + String(PORT) + '.err.log')

const say = (...parts) => console.log(parts.join(' '))
const must = (file, what) => {
  if (!existsSync(file)) {
    say('LONG_VIDEO_E2E_SETUP FAIL ' + what + ' 不存在：' + file)
    process.exit(3)
  }
}

// ---- 1. 隔离数据根：配置照抄，数据全新 --------------------------------------
must(join(SOURCE_HOME, 'settings.yaml'), '模型与媒体路由配置')
must(join(SOURCE_HOME, '.credentials.yaml'), '凭据')
must(join(SOURCE_HOME, 'bosom-friend', 'llm-user.json'), '模型配置')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(UPLOADS, { recursive: true })
copyFileSync(join(SOURCE_HOME, 'settings.yaml'), join(ROOT, 'settings.yaml'))
copyFileSync(join(SOURCE_HOME, '.credentials.yaml'), join(ROOT, '.credentials.yaml'))
copyFileSync(join(SOURCE_HOME, 'bosom-friend', 'llm-user.json'), join(DATA_ROOT, 'llm-user.json'))

const humanFile = join(SOURCE_HOME, 'bosom-friend', 'digital-humans.json')
must(humanFile, '形象库')
const humans = JSON.parse(readFileSync(humanFile, 'utf8')).value ?? []
if (humans.length === 0) {
  say('LONG_VIDEO_E2E_SETUP FAIL 形象库里没有形象——走动 VLOG 必须先建一个数字人')
  process.exit(3)
}
copyFileSync(humanFile, join(DATA_ROOT, 'digital-humans.json'))
const human = humans[0]
const avatarName = basename(String(human.avatarUrl ?? ''))
const avatarSource = join(SOURCE_HOME, 'bosom-friend', 'uploads', avatarName)
must(avatarSource, '形象图素材')
copyFileSync(avatarSource, join(UPLOADS, avatarName))

// 产品图：借用真实数据根里一张**不是形象图**的 AI 图片（逐字节不同的那张）。
// 产品会拦"产品图就是形象图"（productImageMatchesHumanAvatar），所以这里必须挑另一张。
const avatarBytes = readFileSync(avatarSource)
const productName = readdirSync(join(SOURCE_HOME, 'bosom-friend', 'uploads'))
  .find(name => /^ai-img-.*\.(png|jpg|jpeg|webp)$/i.test(name)
    && !readFileSync(join(SOURCE_HOME, 'bosom-friend', 'uploads', name)).equals(avatarBytes))
if (productName === undefined) {
  say('LONG_VIDEO_E2E_SETUP WARN 真实数据根里找不到可用的产品图，本次不带产品图跑')
}
else {
  copyFileSync(join(SOURCE_HOME, 'bosom-friend', 'uploads', productName), join(UPLOADS, productName))
}
const productImageUrl = productName === undefined ? '' : '/bosom-friend/api/assets/file/' + encodeURIComponent(productName)
say('LONG_VIDEO_E2E_SETUP home=' + ROOT + ' origin=' + ORIGIN + ' seconds=' + String(SECONDS) + ' human=' + String(human.id))
say('  settings.yaml / .credentials.yaml / llm-user.json / 形象库已照抄；产品图=' + (productName ?? '(无)'))
// ---- 1.5 先构建产品包，再把 lib 覆盖到 pnpm 注入的副本上 ----------------------
//
// 为什么必须有这一步：运行时的 exports 指向各包的 lib/（不是 src），而 pnpm 在 node_modules/.pnpm 下
// 还注入了一份**副本**；只 build 不覆盖副本，实例加载的仍是旧代码。实测（2026-09-23）：走动 VLOG 在
// 源码里、在实例的 /long-videos/producers 里却不存在，探针如实报了 SKIP。
// 覆盖时先删目标 lib 再整树复制：注入副本与工作区包是硬链接，直接覆盖会报"文件被占用"而整份跳过
// （dev-web.ps1 里同样的教训）。
const REFRESH_PACKAGES = [
  ['dsh-bosom-friend-server', join('products', 'bosom-friend', 'server')],
  ['dsh-bosom-friend-kernel', join('products', 'bosom-friend', 'kernel')],
  ['dsh-bosom-friend-desktop-bundle', join('products', 'bosom-friend', 'bundle', 'desktop')],
  ['dsh-media', join('packages', 'media', 'media')],
  ['dsh-media-pi-ai', join('packages', 'media', 'media-pi-ai')],
]

say('LONG_VIDEO_E2E_SETUP 构建产品包（server + kernel），约 10~30 秒')
// Windows 上 .cmd 必须过 shell；用 cmd.exe 显式包一层，避免 Node 的 shell+args 弃用告警。
const FILTERS = ['--filter', '@deepseek-ai/dsh-bosom-friend-server', '--filter', '@deepseek-ai/dsh-bosom-friend-kernel', 'build']
const build = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm ' + FILTERS.join(' ')], { cwd: REPO, stdio: 'inherit', windowsHide: true })
  : spawnSync('pnpm', FILTERS, { cwd: REPO, stdio: 'inherit' })
if (build.status !== 0) {
  say('LONG_VIDEO_E2E_SETUP FAIL 产品包构建失败（exit ' + String(build.status) + '）')
  process.exit(3)
}
// 能力面的两个包没有 build 脚本（由仓库根的 tsdown 工作区模式打包），这里单独跑它们自己的 tsdown 配置：
// 只刷新副本不重新打包的话，实例加载的仍是旧 bundle（2026-09-23 实测：新导出的 isMediaError 在副本里不存在）。
const TSDOWN = join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'tsdown.cmd' : 'tsdown')
for (const mediaDir of [join('packages', 'media', 'media'), join('packages', 'media', 'media-pi-ai')]) {
  // Windows 上 .cmd 只能过 shell：整条命令作为一个字符串交给 shell（传参数数组会触发 Node 的弃用告警）；
  // 路径带空格，必须自己加引号。
  const bundled = process.platform === 'win32'
    ? spawnSync('"' + TSDOWN + '" --cwd ' + mediaDir, { cwd: REPO, stdio: 'inherit', windowsHide: true, shell: true })
    : spawnSync(TSDOWN, ['--cwd', mediaDir], { cwd: REPO, stdio: 'inherit' })
  if (bundled.status !== 0) {
    say('LONG_VIDEO_E2E_SETUP FAIL 媒体包打包失败：' + mediaDir)
    process.exit(3)
  }
}

const pnpmRoot = join(REPO, 'node_modules', '.pnpm')
let refreshed = 0
let refreshSkipped = 0
for (const [pkg, relativeDir] of REFRESH_PACKAGES) {
  const srcLib = join(REPO, relativeDir, 'lib')
  const srcPatch = join(REPO, relativeDir, 'cordis.patch.yml')
  if (!existsSync(pnpmRoot)) break
  for (const entry of readdirSync(pnpmRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const copy = join(pnpmRoot, entry.name, 'node_modules', '@deepseek-ai', pkg)
    if (!existsSync(copy)) continue
    try {
      if (existsSync(srcLib)) {
        rmSync(join(copy, 'lib'), { recursive: true, force: true })
        cpSync(srcLib, join(copy, 'lib'), { recursive: true })
      }
      if (existsSync(srcPatch)) {
        rmSync(join(copy, 'cordis.patch.yml'), { force: true })
        copyFileSync(srcPatch, join(copy, 'cordis.patch.yml'))
      }
      refreshed += 1
    }
    catch (error) {
      // 有进程正占着那份副本时跳过它：新起的运行时加载的是刷新成功的那些。
      refreshSkipped += 1
      say('  ' + pkg + ' 副本刷新跳过：' + String(error).slice(0, 120))
    }
  }
}
say('LONG_VIDEO_E2E_SETUP 已刷新注入副本 ' + String(refreshed) + ' 份（跳过 ' + String(refreshSkipped) + ' 份）')

// ---- 2. 起源码运行时（与 launcher/scripts/dev-web.ps1 同一套环境变量） ---------
const FRONTEND_DIST = join(REPO, 'products', 'bosom-friend', 'project', 'bosom-friend-electron', 'dist')
const KERNEL_ROOT = join(REPO, 'products', 'bosom-friend', 'bundle', 'kernel')
const FFMPEG = join(REPO, 'products', 'bosom-friend', 'desktop', 'dist', 'runtime', 'ffmpeg.exe')
const desktopPkg = JSON.parse(readFileSync(join(REPO, 'products', 'bosom-friend', 'desktop', 'package.json'), 'utf8'))
const entry = join(REPO, 'products', 'bosom-friend', 'launcher', 'src', 'bin-desktop.ts')
must(entry, '桌面运行时入口')
must(join(KERNEL_ROOT, 'runtime', 'bin-kernel.mjs'), '独立内核入口（缺了每条新任务都会报"内核未运行"）')

const env = {
  ...process.env,
  BOSOM_FRIEND_HOME: ROOT,
  BF_DESKTOP_PORT: String(PORT),
  // 这一条是隔离实例存在的理由：产品默认下限 90 秒，这里设成目标档位，跑的是同一套编排。
  BF_LONG_VIDEO_MIN_SECONDS: String(SECONDS),
  BF_FRONTEND_DIST: FRONTEND_DIST,
  BF_KERNEL_ROOT: KERNEL_ROOT,
  BOSOM_FRIEND_VERSION: String(desktopPkg.version ?? ''),
  CODEBUDDY_SAFE_DELETE_ENABLED: '0',
  ...(existsSync(FFMPEG) ? { FFMPEG_PATH: FFMPEG } : {}),
}
const out = openSync(LOG_OUT, 'w')
const err = openSync(LOG_ERR, 'w')
say('LONG_VIDEO_E2E_SETUP 启动源码运行时（tsx 冷启动 2~3 分钟）：日志 ' + LOG_OUT)
const runtime = spawn(process.execPath, ['--import', 'tsx/esm', entry], {
  cwd: REPO,
  env,
  stdio: ['ignore', out, err],
  windowsHide: true,
})

/** 停掉实例整棵进程树（内核子进程一起收）。 */
function stopRuntime() {
  if (runtime.exitCode !== null || runtime.killed) return
  // 同步收进程树：异步 taskkill 的句柄会在 process.exit 时被关掉，实测触发 libuv 断言
  // （退出码变成 0xC0000409，把本该是 2 的 SKIP 变成一个崩溃）。
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(runtime.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else runtime.kill('SIGTERM')
}

/** 等实例的 API 应答；起不来（含端口被占）时返回 false。 */
async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (runtime.exitCode !== null) return false
    try {
      const response = await fetch(ORIGIN + '/bosom-friend/api/long-videos/producers', { signal: AbortSignal.timeout(5000) })
      if (response.ok) return true
    }
    catch {
      // 还没监听：继续等。
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return false
}

// 端口被占时不要含糊：一个已经在跑的实例会让探针打到别人身上。
let portBusy = false
try {
  await fetch(ORIGIN + '/bosom-friend/', { signal: AbortSignal.timeout(3000) })
  portBusy = true
}
catch {
  portBusy = false
}
if (portBusy) {
  say('LONG_VIDEO_E2E_SETUP FAIL 端口 ' + String(PORT) + ' 已经有服务在应答；换 --port，或先停掉它')
  process.exit(3)
}

const ready = await waitReady(300_000)
if (!ready) {
  say('LONG_VIDEO_E2E_SETUP FAIL 实例 5 分钟内没有起来；看 ' + LOG_ERR)
  const tail = existsSync(LOG_ERR) ? readFileSync(LOG_ERR, 'utf8').trim().split(/\r?\n/).slice(-12).join('\n') : ''
  if (tail !== '') say(tail)
  stopRuntime()
  process.exit(3)
}
say('LONG_VIDEO_E2E_SETUP 实例就绪：' + ORIGIN + '/bosom-friend/')

let code = 0
if (RUN_PROBE) {
  code = await new Promise(resolve => {
    const probe = spawn(process.execPath, [join(REPO, 'products', 'bosom-friend', 'qa', 'probes', 'verify-long-video-e2e.mjs')], {
      cwd: REPO,
      env: {
        ...process.env,
        BF_QA_ORIGIN: ORIGIN,
        BF_LV_SECONDS: String(SECONDS),
        BF_LV_DATA_ROOT: DATA_ROOT,
        BF_LV_HUMAN: String(human.id),
        ...(productImageUrl === '' ? {} : { BF_LV_PRODUCT_IMAGE: productImageUrl }),
      },
      stdio: 'inherit',
    })
    probe.on('exit', value => resolve(value ?? 1))
  })
}
else {
  say('LONG_VIDEO_E2E_SETUP --no-run：实例留在这里；自己跑探针时用 BF_QA_ORIGIN=' + ORIGIN
    + ' BF_LV_DATA_ROOT=' + DATA_ROOT + (productImageUrl === '' ? '' : ' BF_LV_PRODUCT_IMAGE=' + productImageUrl))
}

if (KEEP) say('LONG_VIDEO_E2E_SETUP --keep：实例继续跑（PID ' + String(runtime.pid) + '），收工时 taskkill /PID ' + String(runtime.pid) + ' /T /F')
else stopRuntime()
if (CLEAN) {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  say('LONG_VIDEO_E2E_SETUP --clean：隔离数据根已删除')
}
else if (existsSync(ROOT)) {
  say('LONG_VIDEO_E2E_SETUP 隔离数据根保留：' + ROOT + '（成片与字幕 ASS 都在里面）')
}
// 用 exitCode 而不是 process.exit：进程自然收尾（子进程句柄与 fetch 连接各自关闭），
// 退出码才是探针的结论而不是一次崩溃。
process.exitCode = code
