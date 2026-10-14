/**
 * 平台登录/发布引擎适配器：DSH 后端进程与 vendored social-auto-upload worker 进程之间的桥。
 * 登录/发布业务逻辑全部在开源引擎（MIT）内，本模块只做：进程拉起、状态文件读写、
 * 二维码等待、登录结果落盘为账号。
 * @module @deepseek-ai/dsh-bosom-friend-server/platform-login
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { Deps } from './api.ts'
import type { ZySocialAccount } from './types.ts'
import { enginePythonExe, engineRoot } from './engine-root.ts'
import { pixelFor } from './image-ratio.ts'
import { nowIso, uid } from './store-helper.ts'
import { writeDataJson } from './store.ts'
import { engineKeyForPlatform, platformCatalog } from './platform-catalog.ts'
import { trackChild } from './platform-processes.ts'
import { ffmpegExecutable, runFfmpeg } from './ffmpeg.ts'

/** 前端平台 id → 引擎平台 id（对齐 social-auto-upload 的 type 1/2/3/4）。 */
const ENGINE_PLATFORM: Record<string, string> = {}

/** 引擎平台 id → 前端平台 id。 */
const APP_PLATFORM: Record<string, string> = {
  xhs: 'xhs',
  douyin: 'douyin',
  ks: 'KWAI',
  tencent: 'wxSph',
  bilibili: 'bilibili',
  baijiahao: 'baijiahao',
  alipay: 'alipay',
  weibo: 'weibo',
  hupu: 'hupu',
  tiktok: 'tiktok',
  youtube: 'youtube',
  xianyu: 'xianyu',
}

const PLATFORM_DISPLAY: Record<string, string> = {
  xhs: '小红书',
  douyin: '抖音',
  KWAI: '快手',
  wxSph: '视频号',
  bilibili: '哔哩哔哩',
  baijiahao: '百家号',
  alipay: '支付宝生活号',
  weibo: '微博',
  hupu: '虎扑',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  xianyu: '闲鱼',
}

/** 平台资料占位昵称（引擎未能解析出真实昵称时写入的兜底值），一律回退平台显示名。 */
const PLACEHOLDER_NICKNAMES = new Set(['No name', 'no name', 'NO NAME', '无昵称', '无名', 'anonymous', '平台账号'])

/** 一次采集到的账号资料字段；缺省字段表示本次没采到，保留账号库现值。 */
export interface AccountProfileUpdate {
  nickname?: string | undefined
  avatar?: string | undefined
  fansCount?: number | undefined
}

/**
 * 把一次采集到的账号资料回写到账号库（就地修改，落盘由调用方决定）。
 * 只覆盖确实采到的字段：缺省字段保留现值，避免把登录时的真实值抹成空。
 * @param account - 目标账号
 * @param platform - 账号平台 key，用于昵称兜底显示名
 * @param update - 本次采集到的资料字段
 */
export function applyAccountProfile(account: ZySocialAccount, platform: string, update: AccountProfileUpdate): void {
  if (typeof update.nickname === 'string') account.nickname = cleanPlatformNickname(update.nickname, platform, account.uid)
  if (typeof update.avatar === 'string' && update.avatar !== '') account.avatar = update.avatar
  if (typeof update.fansCount === 'number' && Number.isFinite(update.fansCount)) account.fansCount = update.fansCount
}

/**
 * 清理平台昵称：空白或占位值回退为平台显示名，避免账号列表出现 “No name”。
 *
 * 回退时带上平台 uid：抖音创作者接口对某些账号直接返回 nickname="No name"，
 * 多个同平台账号会全都显示成"抖音"而无法区分谁是谁（实测 2026-09-10）。
 *
 * @param nickname - 平台返回的原始昵称。
 * @param platform - 平台 key，用于取显示名。
 * @param platformUid - 平台账号 uid（可省；有值时用于区分同平台多账号）。
 * @returns 可展示的昵称。
 */
export function cleanPlatformNickname(nickname: string | undefined, platform: string, platformUid?: string): string {
  const fallback = PLATFORM_DISPLAY[platform] ?? (platform + ' 账号')
  const distinguishable = (): string => {
    const uid = (platformUid ?? '').trim()
    if (uid === '') return fallback
    return fallback + ' · ' + (uid.length > 12 ? uid.slice(0, 12) : uid)
  }
  if (typeof nickname !== 'string') return distinguishable()
  const value = nickname.trim()
  if (value === '' || PLACEHOLDER_NICKNAMES.has(value)) return distinguishable()
  return value
}

/** 平台登录会话状态（worker 的 state.json 契约）。 */
export interface LoginState {
  sessionId?: string
  platform?: string
  status?: 'starting' | 'pending' | 'verifying' | 'done' | 'failed'
  qrUrl?: string
  qrAt?: string
  cookieFile?: string
  loginCookie?: string
  nickname?: string
  avatar?: string
  platformUid?: string
  fansCount?: number
  error?: string
  accountId?: string
  /** 账号退出登录时写入；存在即表示本会话的登录态已被吊销，禁止再落盘复活。 */
  revokedAt?: string
}

interface PublishState {
  taskId?: string
  status?: 'starting' | 'uploading' | 'done' | 'failed'
  workLink?: string
  platformWorkId?: string
  error?: string
  startedAt?: string
  finishedAt?: string
  /** 引擎写入的当前阶段（如「已提交，等待平台列表回读」），供收尸文案判断动作是否已执行。 */
  stage?: string
}

const QR_WAIT_MS = 60_000
const QR_TTL_MS = 600_000

/**
 * 发布任务的**总预算**：从引擎启动算起，超过它才允许判超时并终止 worker（DEF-305 的预算表）。
 *
 * 引擎侧最长用时 = 发布步骤（worker.py `PUBLISH_COMMAND_TIMEOUT_S`，默认 ≤ 17 分钟）
 * + 回读（`READBACK_BUDGET_S` 20 分钟）+ 收尾 ≈ 38 分钟。这里取 45 分钟留余量。
 * 任何一侧单独改预算都会把真实发布拦腰杀掉——2026-10-13 现场：旧的 20 分钟看门狗
 * 恰好落在第 21 轮回读中间，一次平台动作已经执行的发布被判超时失败，且无从回读。
 */
export const PUBLISH_TASK_BUDGET_MS = 45 * 60_000

/**
 * 发布结果未知时的统一失败文案（DEF-305）：引擎被终止或超时返回时，平台动作**可能已经执行**，
 * 文案必须引导用户先同步确认、明确禁止直接重发——否则会把同一条内容发两遍（DEF-240 的教训）。
 */
export const PUBLISH_RESULT_UNKNOWN_MESSAGE =
  '发布没有拿到最终确认：引擎在等平台列表回读时被终止或超时，这次发布可能已经在平台上执行。'
  + '请先到「数据中心」对账号做一次同步，确认平台侧是否已发出；确认前**不要重复发布**，避免发出两条。'

/** 从登录 cookie 提取平台创作者 UID；无匹配返回空串。 */
function xhsUidFromLoginCookie(loginCookie: string | undefined): string {
  if (typeof loginCookie !== 'string' || loginCookie === '')
    return ''
  try {
    const cookies = JSON.parse(loginCookie) as { name?: unknown; value?: unknown }[]
    const match = Array.isArray(cookies)
      ? cookies.find(cookie => typeof cookie?.name === 'string' && cookie.name.includes('x-user-id-creator'))
      : undefined
    return typeof match?.value === 'string' ? match.value : ''
  }
  catch {
    return ''
  }
}

/** 常驻登录守护进程（只启动一次，共享重依赖与浏览器冷启动开销）。 */
let engineDaemon: ChildProcess | undefined

function daemonJobsDir(deps: Deps): string {
  return join(deps.dataRoot, 'platform-login', 'daemon-jobs')
}

export function ensureEngineDaemon(deps: Deps): boolean {
  if (engineDaemon !== undefined && engineDaemon.exitCode === null && !engineDaemon.killed) {
    return true
  }
  const exe = pythonExe()
  if (!existsSync(exe) || !existsSync(join(engineDir(), 'worker.py'))) return false
  const jobsDir = daemonJobsDir(deps)
  mkdirSync(jobsDir, { recursive: true })
  engineDaemon = trackChild(spawn(exe, [join(engineDir(), 'worker.py'), 'daemon', jobsDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }))
  engineDaemon.unref()
  return true
}

function isEngineDaemonAlive(): boolean {
  return engineDaemon !== undefined && engineDaemon.exitCode === null && !engineDaemon.killed
}

function engineDir(): string {
  return engineRoot()
}

function pythonExe(): string {
  return enginePythonExe()
}

function sessionDirOf(deps: Deps, sessionId: string): string {
  return join(deps.dataRoot, 'platform-login', 'sessions', sessionId)
}

/** 登录会话平台：优先取 state.platform，缺失时回退 meta.json（worker 早期状态可能未写 platform）。 */
function platformForSession(sessionDir: string, state: LoginState): string {
  const direct = APP_PLATFORM[state.platform ?? ''] ?? state.platform
  if (direct) return direct
  const meta = readJson<{ platform?: string }>(join(sessionDir, 'meta.json'))
  return APP_PLATFORM[meta?.platform ?? ''] ?? meta?.platform ?? 'xhs'
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function writeJson(file: string, value: unknown): void {
  writeDataJson(file, value)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function spawnWorker(args: string[], cwd: string): boolean {
  const exe = pythonExe()
  if (!existsSync(exe) || !existsSync(join(engineDir(), 'worker.py'))) return false
  // 引擎输出此前被 stdio:'ignore' 整个丢掉：发布失败时既没有日志也没有错误原文，
  // 任务状态停在 starting、界面停在"发布中"，排查只能靠猜（2026-09-29 实测一次卡死）。
  // 采集到任务目录的 worker.log —— cwd 就是该任务的目录。
  let logFd: number | undefined
  try {
    logFd = openSync(join(cwd, 'worker.log'), 'a')
  }
  catch {
    logFd = undefined
  }
  const child = trackChild(spawn(exe, [join(engineDir(), 'worker.py'), ...args], {
    cwd,
    detached: true,
    stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
    windowsHide: true,
  }))
  if (logFd !== undefined) {
    // 父进程关掉自己的副本；子进程持有独立句柄，继续写入。
    try { closeSync(logFd) }
    catch { /* 关闭失败不影响子进程写入 */ }
  }
  child.unref()
  // 记下 PID：看门狗判超时后要按这棵树终止它，否则服务端已经报失败、引擎还在跑，
  // 继续占着平台账号，用户重试就是两个会话抢同一个账号。
  // PID 必须落在**任务目录**：看门狗是按 taskId 找这个文件来终止进程的，
  // 而 cwd 是引擎目录——写到那里等于超时清理永远是空操作（实测：僵尸 worker 一直占着账号）。
  // publish / cover 的 args 形如 ['publish', taskId, taskDir]，taskDir 就是最后一项。
  const pidDir = typeof args[2] === 'string' && args[2] !== '' ? args[2] : cwd
  if (child.pid !== undefined) {
    try { writeFileSync(join(pidDir, 'worker.pid'), String(child.pid), 'utf8') }
    catch { /* 写不下 PID 只影响超时清理，发布本身照常进行 */ }
  }
  return true
}

export interface LoginStartOk {
  ok: true
  url: string
  sessionId: string
  expiresAt: string
}

export interface LoginStartFail {
  ok: false
  error: string
}

/**
 * 计划平台（已列入产品清单、引擎模块未落地）的如实拒绝理由。
 *
 * 这类平台在目录里是 coming_soon：界面上已经置灰，但直接调接口仍会走到引擎，
 * 由引擎报一句"不支持的登录平台"——把请求丢给不可能成功的下游，用户看不懂。
 *
 * @param platform - 前端平台 id。
 * @returns 该平台未开放时的说明；可用的平台返回 undefined。
 */
function unavailablePlatformReason(platform: string): string | undefined {
  const item = platformCatalog().find(entry => entry.platform === platform)
  return item?.status === 'coming_soon' ? item.name + ' 暂未开放，敬请期待' : undefined
}

/**
 * 找出该平台**尚未结束**的登录会话（starting / pending / verifying）。
 *
 * 为什么必须有这道闸门：登录是"两个进程抢同一份 cookie"的动作。2026-09-29 现场，
 * 28 秒内发起了两次登录（plogin-02u1qnr4 与 plogin-vil8z3j3），两个会话互相顶号，
 * 刚扫好的 cookie 12 分钟就失效，之后所有发布都报"登录已失效"。
 * 缺陷台账 DEF-184 记的正是"登录侧没有并发闸门"，当天造成了实际后果。
 *
 * @param deps - 依赖（用来定位会话目录）。
 * @param platform - 前端平台 id。
 * @returns 未结束会话的 id；没有则 undefined。
 */
/** 登录会话的兜底存活时长：超过它即使没写终态也不再阻塞新登录。 */
const LOGIN_SESSION_STALE_MS = 5 * 60 * 1000

/** 软证据的确认窗口：这段时间内连续两次报告，才判定登录失效。 */
export const LOGIN_SUSPECT_WINDOW_MS = 30 * 60 * 1000

/**
 * 记录一次「平台报告登录失效」，并判定是否**确认**失效。
 *
 * 为什么要分级（2026-10-11 实测）：作品同步判定登录失效靠的是**页面上有没有登录框文字**
 * （引擎 worker.py 的 _sync_douyin_works），页面加载慢就会误报；而一次误报就把账号锁成
 * invalid，之后所有发布全被拦，用户只能重新扫码——这是产品负责人长期苦恼的问题。
 * 所以只有**引擎明确报凭据问题**算硬证据、立即确认；其余（「登录已失效」这类可能来自页面推断）
 * 要短时间内**连续两次**才算数，单次只留痕。
 *
 * @param account - 账号记录；函数会就地更新疑似计数与备注。
 * @param message - 平台/引擎返回的失败原文。
 * @returns 是否确认登录已失效（true 时调用方应把 loginState 置为 invalid）。
 */
export function confirmLoginInvalid(
  account: { loginSuspectAt?: string, loginSuspectCount?: number, loginNote?: string },
  message: string,
): boolean {
  const hardEvidence = /cookie is missing or expired|cookie.*expired|凭据.*(失效|过期)/i.test(message)
  const now = Date.now()
  const last = Date.parse(String(account.loginSuspectAt ?? ''))
  const withinWindow = Number.isFinite(last) && now - last < LOGIN_SUSPECT_WINDOW_MS
  const count = withinWindow ? Number(account.loginSuspectCount ?? 0) + 1 : 1
  account.loginSuspectAt = new Date(now).toISOString()
  account.loginSuspectCount = count
  account.loginNote = message
  if (hardEvidence || count >= 2) {
    // 确认失效后计数归零：下次再出问题重新从 1 数起。
    account.loginSuspectCount = 0
    return true
  }
  return false
}

function findPendingLogin(deps: Deps, platform: string): { id: string } | undefined {
  const dir = join(deps.dataRoot, 'platform-login', 'sessions')
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return undefined }
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, name, 'meta.json'), 'utf8')) as { platform?: unknown }
      if (String(meta.platform ?? '') !== platform) continue
      const state = JSON.parse(readFileSync(join(dir, name, 'state.json'), 'utf8')) as { status?: unknown }
      const status = String(state.status ?? 'starting')
      if (status === 'done' || status === 'failed' || status === 'expired' || status === 'cancelled') continue
      // 兜底超时：扫码授权可能在平台侧失败（"授权失败，请重试"）而引擎不写终态。
      // 少了这道超时，一次失败的登录会把后续所有登录永久挡住 —— 2026-09-29 现场就是这么卡住用户的。
      const age = Date.now() - statSync(join(dir, name, 'meta.json')).mtimeMs
      if (age > LOGIN_SESSION_STALE_MS) continue
      return { id: name }
    } catch {
      // 会话目录刚建、状态文件还没落盘（或已损坏）：跳过而不是当成阻塞，避免把噪声变成长时间拒登。
    }
  }
  return undefined
}

/** 启动真实平台扫码登录，等待引擎产出二维码后返回。 */
export async function startPlatformLogin(deps: Deps, platform: string, groupId?: string): Promise<LoginStartOk | LoginStartFail> {
  await sleep(0)
  const unavailable = unavailablePlatformReason(platform)
  if (unavailable !== undefined)
    return { ok: false, error: unavailable }
  const enginePlatform = engineKeyForPlatform(platform) ?? ENGINE_PLATFORM[platform]
  if (enginePlatform === undefined) {
    return { ok: false, error: `该平台暂不支持扫码登录，请先接入平台官方能力（${platform}）` }
  }
  if (!existsSync(pythonExe()) || !existsSync(join(engineDir(), 'worker.py'))) {
    return { ok: false, error: '平台登录引擎未安装（Python 环境缺失），无法进行真实登录' }
  }
  // 并发闸门：同一平台已有未结束的登录会话时直接拒绝。
  // 少了这一道，连点两次登录就会开两个会话抢同一份 cookie，互相顶号。
  const pendingLogin = findPendingLogin(deps, platform)
  if (pendingLogin !== undefined) {
    return {
      ok: false,
      error: '该平台已有登录会话在进行中（' + pendingLogin.id + '）。请等它完成或取消后再试——'
        + '同时开两个登录会让它们互相顶号，刚扫好的 cookie 会立刻失效。',
    }
  }
  const sessionId = uid('plogin')
  const sessionDir = sessionDirOf(deps, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  writeJson(join(sessionDir, 'meta.json'), { sessionId, platform, groupId: groupId ?? '' })
  if (!ensureEngineDaemon(deps)) return { ok: false, error: '平台登录引擎未运行，无法发起真实登录' }
  writeJson(join(daemonJobsDir(deps), 'job-' + sessionId + '.json'), {
    id: sessionId,
    platform: enginePlatform,
    stateDir: sessionDir,
  })
  // 立即返回：前端秒开扫码页，二维码就绪后由 /platform-login/qr/:sessionId 异步提供
  return {
    ok: true,
    url: '/bosom-friend/api/platform-login/qr/' + sessionId,
    sessionId,
    expiresAt: new Date(Date.now() + QR_TTL_MS + QR_WAIT_MS).toISOString(),
  }
}

/** 读取登录二维码图片字节（data URL 直接解码；http(s) 转取；未就绪时等待最多 QR_WAIT_MS）。 */
export async function readLoginQr(deps: Deps, sessionId: string): Promise<{ ok: true; body: Buffer; mime: string } | { ok: false; error: string }> {
  const sessionDir = sessionDirOf(deps, sessionId)
  const deadline = Date.now() + QR_WAIT_MS
  while (Date.now() < deadline) {
    const state = readJson<LoginState>(join(sessionDir, 'state.json'))
    if (state?.status === 'failed') {
      return { ok: false, error: state.error ?? '平台登录失败' }
    }
    if (typeof state?.qrUrl === 'string' && state.qrUrl !== '') {
      if (state.qrUrl.startsWith('data:image/')) {
        const comma = state.qrUrl.indexOf(',')
        const mime = state.qrUrl.slice(5, state.qrUrl.indexOf(';')) || 'image/png'
        const b64 = comma >= 0 ? state.qrUrl.slice(comma + 1) : ''
        return { ok: true, body: Buffer.from(b64, 'base64'), mime }
      }
      try {
        const resp = await fetch(state.qrUrl, { signal: AbortSignal.timeout(15000) })
        if (resp.ok) {
          return { ok: true, body: Buffer.from(await resp.arrayBuffer()), mime: resp.headers.get('content-type') ?? 'image/png' }
        }
      } catch {
        // 下载失败继续等待（网络抖动）
      }
    }
    await sleep(250)
  }
  return { ok: false, error: '平台二维码生成超时，请重试' }
}

export interface LoginStatus {
  sessionId: string
  status: 'pending' | 'completed' | 'failed'
  requiresSelection: boolean
  accountId?: string
  accountIds?: string[]
  accounts?: { accountId: string; platform: string; nickname: string }[]
  selectableAccounts: never[]
  message?: string
}

/**
 * 平台授权失败发生在哪一步：给用户的指引要按阶段给，才对得上他眼前看到的画面。
 *
 * - `等待二维码`：浏览器/定位器还没把码取出来，用户手上没有可扫的东西；
 * - `等待扫码`：码已经发出去，用户还没扫或扫了没成功；
 * - `平台校验`：已经扫码，卡在平台侧的授权校验（平台拒绝、风控、二次验证）。
 */
export type LoginFailureStage = '等待二维码' | '等待扫码' | '平台校验'

/**
 * 从会话状态与错误原文判断这次授权失败卡在哪一步。
 *
 * 判据顺序：先认错误原文里**引擎自己写的阶段**（各条失败文案已经写明了），
 * 再用 state 字段兜底（有没有二维码、有没有拿到会话材料）。
 * 为什么不新增 `stage` 字段：engine 侧的改动要走 vendored 流程，而这几件事
 * 在现有 state.json 里已经写下来了（`qrAt`/`qrUrl`/`loginCookie`），够判断。
 *
 * @param state - 登录会话状态（worker 写的 state.json）。
 * @param raw - 失败原文（state.error）。
 * @returns 阶段名（直接拼进给用户的文案）。
 */
export function loginFailureStage(state: LoginState | undefined, raw: string): LoginFailureStage {
  if (/平台登录失败|授权失败|授权过程中|授权异常|验证失败|风控|操作频繁/.test(raw)) return '平台校验'
  if (/等待扫码超时|扫码超时/.test(raw)) return '等待扫码'
  if (/二维码/.test(raw)) return '等待二维码'
  // 原文没写阶段就用 state 兜底：已有 cookie/昵称说明扫码已经过了，
  // 有二维码时间说明码已经发出去（用户手上有一张码）。
  if (typeof state?.loginCookie === 'string' && state.loginCookie !== '') return '平台校验'
  if (state?.qrAt !== undefined || state?.qrUrl !== undefined) return '等待扫码'
  return '等待二维码'
}

/**
 * 登录失败时给用户的文案：**阶段 + 原文 + 可执行的下一步**（DEF-197）。
 *
 * 为什么要带上原文与阶段：只说"授权失败"时，用户拿不到任何可执行的区分——
 * 平台侧拒绝授权、二维码已过期、网络被拦是三种不同的处置。原文是平台/引擎真正说的话，
 * 保留它；前面补上卡在哪一步，后面补三选一的具体动作。
 * 平台侧文案（例如"授权失败，授权过程中出现错误，请重试"）此前不命中任何判据、
 * 被原样透传，用户只看到一个重试按钮——这正是本条要修的。
 *
 * @param state - 登录会话状态。
 * @param raw - 失败原文（state.error）。
 * @returns 给用户看的一句话。
 */
export function describePlatformLoginFailure(state: LoginState | undefined, raw: string): string {
  const stage = loginFailureStage(state, raw)
  const detail = raw.trim() === ''
    ? '引擎没有留下失败原因'
    : (raw.trim().length > 160 ? raw.trim().slice(0, 160) + '…' : raw.trim())
  return '平台授权失败（卡在「' + stage + '」）：' + detail + '。可以按顺序试：'
    + '① 重新扫码——点“重试”拿一张新二维码（二维码 10 分钟内有效，旧码会失效）；'
    + '② 换一个网络再扫——用手机热点或切到手机流量，代理、公司网与校园网常被平台判为异常登录；'
    + '③ 隔几分钟再试——同一账号短时间内反复授权会触发平台风控，等一会儿再扫通常就能过。'
}

/** 读取登录会话状态；成功后把真实账号（昵称/头像/cookie）落盘到账号库并返回账号 id。 */
export function getPlatformLoginStatus(deps: Deps, sessionId: string): LoginStatus {
  const sessionDir = sessionDirOf(deps, sessionId)
  const state = readJson<LoginState>(join(sessionDir, 'state.json'))
  const base = { sessionId, requiresSelection: false, selectableAccounts: [] as never[] }
  // 已吊销会话（退出登录/删除账号）：一律失败，杜绝旧 cookie 经轮询复活。
  if (state?.revokedAt !== undefined) {
    return { ...base, status: 'failed', message: '该登录会话已退出，请重新扫码登录' }
  }
  if (state === undefined || state.status === undefined || state.status === 'starting' || state.status === 'pending' || state.status === 'verifying') {
    if (state?.status === 'starting' && !isEngineDaemonAlive()) {
      return { ...base, status: 'failed', message: '登录引擎已停止，请重新发起登录' }
    }
    return { ...base, status: 'pending' }
  }
  if (state.status === 'failed') {
    // 对用户只给可读结论；内部定位器/堆栈仅保留在 state.json 供环境诊断。
    const raw = state.error ?? ''
    // 二维码根本没取出来（本机浏览器/定位器问题）与"平台拒绝授权"是两回事：
    // 前者只有一个可执行动作（重新拿码），保留这句更像操作说明的原文案；
    // 其余失败一律带上**阶段 + 原文 + 三选一指引**（DEF-197），不再原样透传给用户一个光秃秃的报错。
    const friendly = /Locator\.click|Timeout|Call log|playwright|spinner-props|login-box/.test(raw)
      ? '二维码加载失败或已过期，请点击“重试”重新获取二维码'
      : describePlatformLoginFailure(state, raw)
    return { ...base, status: 'failed', message: friendly || '平台登录失败，请重试' }
  }
  const accountId = ensureAccountMaterialized(deps, sessionDir, state)
  const appPlatform = platformForSession(sessionDir, state)
  return {
    ...base,
    status: 'completed',
    accountId,
    accountIds: [accountId],
    accounts: [{ accountId, platform: appPlatform, nickname: cleanPlatformNickname(state.nickname, appPlatform) }],
  }
}

/** 幂等落盘：一次登录只生成一个账号（状态文件记 accountId 防止轮询竞态）。 */
function ensureAccountMaterialized(deps: Deps, sessionDir: string, state: LoginState): string {
  // 已吊销会话不落任何账号数据（防御：轮询竞态下的二次入口）。
  if (state.revokedAt !== undefined) return ''
  if (typeof state.accountId === 'string' && state.accountId !== '') return state.accountId
  const meta = readJson<{ platform?: string; groupId?: string }>(join(sessionDir, 'meta.json'))
  const appPlatform = platformForSession(sessionDir, state)
  const accounts = deps.store.files.accounts.load()
  const platformUid = typeof state.platformUid === 'string' && state.platformUid !== ''
    ? state.platformUid
    : xhsUidFromLoginCookie(state.loginCookie)
  const existing = platformUid
    ? accounts.find(account => account.type === appPlatform && account.uid === platformUid)
    : undefined
  if (existing !== undefined) {
    if (typeof state.loginCookie === 'string' && state.loginCookie !== '') {
      existing.loginCookie = state.loginCookie
    }
    // 扫码成功即证明平台接受了这个会话：登录态**当场**置为有效，并清掉旧的失效标记与疑似计数。
    // 少了这一步，用户刚扫完码账号页仍显示「已失效」，要等下一次同步才恢复——他会以为没扫上
    // （2026-10-11 实测：用户扫完码后 loginState 仍是 invalid，靠跑一次同步才变回 valid）。
    existing.loginState = 'valid'
    existing.loginCheckedAt = nowIso()
    existing.loginNote = ''
    existing.loginSuspectCount = 0
    existing.nickname = cleanPlatformNickname(state.nickname, appPlatform)
    if (state.avatar) existing.avatar = state.avatar
    if (typeof state.fansCount === 'number') existing.fansCount = state.fansCount
    existing.updateTime = nowIso()
    deps.store.files.accounts.save(accounts)
    const next = { ...state, accountId: existing.id }
    writeJson(join(sessionDir, 'state.json'), next)
    return existing.id
  }
  const account = {
    id: uid('acc'),
    type: appPlatform,
    uid: platformUid,
    avatar: state.avatar ?? '',
    nickname: cleanPlatformNickname(state.nickname, appPlatform),
    loginCookie: state.loginCookie ?? '',
    // 只写登录流程真的采到的粉丝数；关注/作品/收益这一刻都没有数据，
    // 写 0 等于声称「这个号 0 关注、0 作品」，界面应显示未采集（要求二 R3）。
    ...(typeof state.fansCount === 'number' ? { fansCount: state.fansCount } : {}),
    status: 1,
    // 刚扫码建号，登录态必然有效；显式写下来，避免账号页显示「未知（还没有平台侧判定）」。
    loginState: 'valid' as const,
    loginCheckedAt: nowIso(),
    rank: accounts.length,
    groupId: meta?.groupId && meta.groupId !== '' ? meta.groupId : 'grp-default',
    clientType: 'web',
    createTime: nowIso(),
    updateTime: nowIso(),
  }
  accounts.push(account)
  deps.store.files.accounts.save(accounts)
  const next = { ...state, accountId: account.id }
  writeJson(join(sessionDir, 'state.json'), next)
  // 登录先上屏，昵称/头像由后台补传（不阻塞账号出现）
  const storageFile = typeof state.cookieFile === 'string' && state.cookieFile !== ''
    ? state.cookieFile
    : join(sessionDir, 'storage.json')
  enrichAccountProfile(deps, account.id, appPlatform, storageFile)
  return account.id
}

/** 登录成功后后台补传账号资料：昵称/头像/粉丝数就绪即回写账号库，不阻塞登录结果。 */
function enrichAccountProfile(deps: Deps, accountId: string, platform: string, storageFile: string): void {
  const exe = pythonExe()
  if (!existsSync(exe) || !existsSync(storageFile)) return
  const taskId = uid('prof')
  const taskDir = join(deps.dataRoot, 'platform-login', 'profile', taskId)
  mkdirSync(taskDir, { recursive: true })
  const child = trackChild(spawn(exe, [join(engineDir(), 'worker.py'), 'profile', platform, storageFile, taskDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }))
  child.unref()
  const deadline = Date.now() + 25_000
  const poll = setInterval(() => {
    const state = readJson<{ status?: string; nickname?: string; avatar?: string; fansCount?: number }>(join(taskDir, 'state.json'))
    if ((state?.status === 'done' || state?.status === 'empty') || Date.now() > deadline) {
      clearInterval(poll)
      if (state?.status === 'done' && (state.nickname || state.avatar)) {
        const accounts = deps.store.files.accounts.load()
        const account = accounts.find(a => a.id === accountId)
        if (account !== undefined) {
          applyAccountProfile(account, platform, {
            nickname: state.nickname ?? '',
            avatar: state.avatar,
            fansCount: state.fansCount,
          })
          account.updateTime = nowIso()
          deps.store.files.accounts.save(accounts)
        }
      }
    }
  }, 1000)
}

/**
 * 吊销某账号的全部登录会话（退出登录/删除账号时调用）。
 * 命中规则：state.accountId 等于该账号 id，或（平台一致且 platformUid 一致）。
 * 处理：抹除 state.json 中的 loginCookie/cookieFile、写 revokedAt，并删除该
 * 会话目录内的明文 cookie 文件（storage.json 等）。只清理会话目录自身文件，
 * 绝不越出 sessions/<sessionId>/ 边界。
 * @returns 吊销的会话数（供路由层返回/日志）。
 */
export function revokeAccountLoginSessions(
  deps: Deps,
  account: Pick<ZySocialAccount, 'id' | 'type' | 'uid'>,
): number {
  const sessionsRoot = join(deps.dataRoot, 'platform-login', 'sessions')
  if (!existsSync(sessionsRoot)) return 0
  let revoked = 0
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sessionDir = join(sessionsRoot, entry.name)
    const stateFile = join(sessionDir, 'state.json')
    const state = readJson<LoginState>(stateFile)
    if (state === undefined) continue
    const sameAccount = state.accountId === account.id
    const sameIdentity = state.platform === account.type
      && typeof account.uid === 'string' && account.uid !== ''
      && state.platformUid === account.uid
    if (!sameAccount && !sameIdentity) continue
    // 1) 抹除明文 cookie 引用并标记吊销：即使 state.json 残留，也不再含登录态，
    //    且 getPlatformLoginStatus 会因 revokedAt 拒绝复活。
    const next: LoginState = { ...state, revokedAt: nowIso() }
    delete next.loginCookie
    delete next.cookieFile
    try { writeJson(stateFile, next) } catch { /* 写失败时仍继续删明文文件 */ }
    // 2) 删除会话目录内的明文 cookie 文件（storage.json / 历史二维码截图保留无关紧要，
    //    但 storage.json 是 Playwright cookie 正本，必须删除）。
    for (const file of readdirSync(sessionDir)) {
      if (file === 'storage.json' || file.startsWith('storage_')) {
        try { rmSync(join(sessionDir, file), { force: true }) } catch { /* 占用/权限失败不阻断 */ }
      }
    }
    revoked += 1
  }
  return revoked
}

export interface PublishStartOk {
  ok: true
  taskId: string
}

export interface PublishStartFail {
  ok: false
  error: string
}

/**
 * 拉起真实发布 worker：标题/描述/话题 + 本地媒体文件 + 目标账号 cookie。
 *
 * `declaration` 是**内容标注**（网信办 2026-05 起为发布必经环节）：抖音侧叫"自主声明"，
 * 引擎按这段文字在声明弹窗里点选（实测选项形如"内容由AI生成"/"内容为个人观点"）。
 * 不传时引擎自己兜底成"内容由AI生成"——产品出的是 AI 内容，这本来就是正确的一项，
 * 但我们把它显式传下去：用户能在发布前看见并改（例如同时带货要改成含营销信息的声明）。
 */
export function startPlatformPublish(deps: Deps, taskId: string, input: {
  platform: string
  type: string
  title: string
  desc: string
  topics: string[]
  mediaFiles: string[]
  loginCookie: string
  isDraft?: boolean
  declaration?: string
  /** 平台账号 id：引擎按它复用同一个持久浏览器档案，避免每次发布都被平台当成新设备登录。 */
  accountId?: string
  /** 封面图本地路径（可选）。缺省时平台只能拿视频首帧当封面，实拍片常常是黑屏。 */
  thumbnailPath?: string
  /** 位置标签（可选）：抖音「添加标签 → 位置」用的地名，留空就不加位置。 */
  location?: string
}): PublishStartOk | PublishStartFail {
  const unavailable = unavailablePlatformReason(input.platform)
  if (unavailable !== undefined)
    return { ok: false, error: unavailable }
  const enginePlatform = engineKeyForPlatform(input.platform) ?? ENGINE_PLATFORM[input.platform]
  if (enginePlatform === undefined) {
    return { ok: false, error: `该平台暂不支持自动发布（${input.platform}）` }
  }
  if (!existsSync(pythonExe()) || !existsSync(join(engineDir(), 'worker.py'))) {
    return { ok: false, error: '平台发布引擎未安装（Python 环境缺失）' }
  }
  const taskDir = join(deps.dataRoot, 'platform-login', 'publish', taskId)
  mkdirSync(taskDir, { recursive: true })
  // storage_state 由账号 cookie 重建，供引擎复用（引擎只认 Playwright storage_state 格式）。
  const storageFile = join(taskDir, 'storage.json')
  let cookies: unknown
  try {
    cookies = JSON.parse(input.loginCookie)
  } catch {
    cookies = []
  }
  writeJson(storageFile, { cookies: Array.isArray(cookies) ? cookies : [], origins: [] })
  writeJson(join(taskDir, 'input.json'), {
    taskId,
    platform: enginePlatform,
    type: input.type,
    title: input.title,
    desc: input.desc,
    topics: input.topics,
    mediaFiles: input.mediaFiles,
    storageFile,
    isDraft: input.isDraft === true,
    // 账号维度复用持久档案（引擎按 accountId 命名 profile）：缺了它引擎只能按任务命名，
    // 每次发布都是全新设备，重新扫码后的第一次发布必弹短信验证（2026-09-29 现场）。
    ...(input.accountId === undefined || input.accountId === '' ? {} : { accountId: input.accountId }),
    // 封面必须显式落进 input.json：引擎只认 thumbnailPath 这个键（键名缺失就用视频首帧），
    // 而实拍片首帧常常是黑的——实测发布出去的封面全黑就是这个原因。
    ...(input.thumbnailPath === undefined || input.thumbnailPath === '' ? {} : { thumbnailPath: input.thumbnailPath }),
    // 内容标注：显式落进 input.json，由 worker 转成引擎的 --declaration。
    ...(input.declaration === undefined || input.declaration === '' ? {} : { declaration: input.declaration }),
    // 位置标签：显式落进 input.json，由 worker 转成引擎的 --location（用户点名的六项之一）。
    ...(input.location === undefined || input.location === '' ? {} : { location: input.location }),
  })
  const launched = spawnWorker(['publish', taskId, taskDir], engineDir())
  if (!launched) return { ok: false, error: '平台发布引擎启动失败' }
  writeJson(join(taskDir, 'state.json'), { taskId, status: 'starting', startedAt: nowIso() } satisfies PublishState)
  return { ok: true, taskId }
}

/**
 * 终止某个发布任务的引擎进程树（worker.py 及其拉起的 Chrome）。
 *
 * 服务端判超时后只改 state.json 是不够的：引擎进程仍在跑并继续占着平台账号，
 * 用户重试就会和它抢同一个账号，登录态被平台顶掉——2026-09-29 现场四次 AI 发布
 * 连续失败正是这个叠加。taskkill /T 会连带清掉它拉起的浏览器。
 *
 * @param taskDir - 发布任务目录（worker.pid 所在处）。
 */
export function killPublishWorker(taskDir: string): void {
  const pidFile = join(taskDir, 'worker.pid')
  let pid = 0
  try {
    pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  }
  catch {
    return
  }
  if (!Number.isInteger(pid) || pid <= 0) return
  // PID 会被系统复用：先确认这个 PID 现在仍是 Python 引擎进程，再动手。
  try {
    const probe = spawnSync('tasklist', ['/FI', 'PID eq ' + String(pid), '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    if (!(probe.stdout ?? '').toLowerCase().includes('python')) return
  }
  catch {
    return
  }
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 })
  }
  catch {
    // 进程可能已经自己退出
  }
  try { rmSync(pidFile, { force: true }) }
  catch { /* 删不掉不影响结果 */ }
}

/** 悬挂回收要回写的最小记录字段（注入式，避免本模块依赖 store 的类型）。 */
export interface PublishRecordLike {
  id: string
  accountId?: string
  title?: string
  status: number
  errorMsg?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * 读 publish 任务的 worker.pid 并判断进程是否还在（判据只看硬事实，不猜）。
 *
 * @param taskDir - publish 任务目录（worker.pid 所在处）。
 * @returns worker 进程是否存活；pid 文件缺失、内容非法或进程不存在都是 false。
 */
function publishWorkerAlive(taskDir: string): boolean {
  let pid = 0
  try { pid = Number.parseInt(readFileSync(join(taskDir, 'worker.pid'), 'utf8').trim(), 10) }
  catch { return false }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch { return false }
}

/**
 * 悬挂发布回收（DEF-304，2026-10-13）：进程被杀或机器异常后，`platform-login/publish/<taskId>` 的
 * state 会永远停在 starting/uploading——后果不止是记录卡「发布中」：**同账号串行闸门
 * （routes-channels 的 findRunningPublish 按 state 判定）会被它永久挡住，该账号此后一条都发不出去**。
 *
 * 判据只看硬事实（不猜）：state 仍在跑，且满足任一——① worker.pid 对应进程已不存在（任务已启动
 * 超过 60 秒，避开"刚拉起还没写 pid"的窗口）；② 已超过 {@link PUBLISH_TASK_BUDGET_MS} 看门狗阈值。命中即：
 * ① 把 state 判 failed（解除串行闸门）；② 按「同账号 + 同标题 + 时间窗 ±120 秒」把它对应的发布
 * 记录标失败并写明原因（历史任务没有 recordId 字段，只能这样对上；匹配不上就只收 state，不猜）。
 *
 * 调用点：启动时的发布调度恢复之前（api.ts）——重启后没人在轮询这些死任务，只有启动这一轮能收。
 *
 * @param opts.dataRoot - 产品数据根。
 * @param opts.loadRecords - 读取发布记录（注入）。
 * @param opts.saveRecords - 回写发布记录（注入）。
 * @returns 被回收的任务名（供启动日志）。
 */
export function sweepStalePublishTasks<T extends PublishRecordLike>(opts: {
  dataRoot: string
  loadRecords: () => T[]
  saveRecords: (records: T[]) => void
}): string[] {
  const root = join(opts.dataRoot, 'platform-login', 'publish')
  const swept: string[] = []
  let names: string[] = []
  try { names = readdirSync(root) }
  catch { return swept }
  let records: T[] = []
  try { records = opts.loadRecords() }
  catch { records = [] }
  let recordsChanged = false
  for (const name of names) {
    const dir = join(root, name)
    const state = readJson<{ status?: string, startedAt?: string }>(join(dir, 'state.json'))
    if (state === undefined) continue
    const startedAt = state.startedAt === undefined ? Number.NaN : Date.parse(state.startedAt)
    if (state.status === 'starting' || state.status === 'uploading') {
      // ① 回收：还在「跑」但进程已死的任务（太新的跳过，避开刚拉起还没写 pid 的窗口）。
      if (!Number.isFinite(startedAt) || Date.now() - startedAt < 60_000) continue
      const alive = publishWorkerAlive(dir)
      const timedOut = Number.isFinite(startedAt) && Date.now() - startedAt > PUBLISH_TASK_BUDGET_MS
      if (alive && !timedOut) continue
      try { writeJson(join(dir, 'state.json'), { ...state, status: 'failed', error: PUBLISH_RESULT_UNKNOWN_MESSAGE, finishedAt: nowIso() }) }
      catch { continue } // state 写不动就不动记录：两边必须一致，宁可下一轮再收
      swept.push(name)
    } else if (state.status !== 'failed') {
      continue // 终态不是失败（done 等）：对账归平台同步管，这里只管失败补账
    }
    // ② 记录补账（幂等，两类都做）：state 已是 failed、但记录还停在「发布中」的——
    // 按 同账号 + 同标题 + 时间窗 找回来标失败（历史任务没有 recordId 字段，匹配不上不猜）。
    // 这样既有启动清理（先改 state）与本函数谁先跑都能收干净，重复跑也不会改已收过的记录。
    if (!Number.isFinite(startedAt)) continue
    const input = readJson<{ accountId?: string, title?: string }>(join(dir, 'input.json'))
    if (input === undefined) continue
    const hit = records.find(record =>
      record.status === 2
      && record.accountId === input.accountId
      && record.title === input.title
      && record.createdAt !== undefined
      && Math.abs(Date.parse(record.createdAt) - startedAt) < 120_000)
    if (hit === undefined) continue
    hit.status = -1
    hit.errorMsg = PUBLISH_RESULT_UNKNOWN_MESSAGE
    hit.updatedAt = nowIso()
    recordsChanged = true
  }
  if (recordsChanged) {
    try { opts.saveRecords(records) }
    catch { /* 记录回写失败：state 已收（闸门已解除），下一轮启动再补 */ }
  }
  return swept
}

/** 读取发布结果（供发布调度器在完成/失败时回写记录）。 */
export function getPublishState(deps: Deps, taskId: string): PublishState | undefined {
  const file = join(deps.dataRoot, 'platform-login', 'publish', taskId, 'state.json')
  const state = readJson<PublishState>(file)
  if (state?.status === 'starting' || state?.status === 'uploading') {
    const startedAt = state.startedAt ? Date.parse(state.startedAt) : 0
    const taskDir = join(deps.dataRoot, 'platform-login', 'publish', taskId)
    // ① 进程已死但 state 还停在「跑」：不用等预算耗尽，立刻收（与启动悬挂回收同一判据）；
    //    太新的跳过，避开"刚拉起还没写 pid"的窗口。
    const oldEnough = Number.isFinite(startedAt) && Date.now() - startedAt > 60_000
    const dead = oldEnough && !publishWorkerAlive(taskDir)
    // ② 预算耗尽：阈值原来是 5 分钟，修正到与引擎总预算对齐的 {@link PUBLISH_TASK_BUDGET_MS}——
    //    把一条 27MB 的视频传到抖音再等它处理，实测要 5 分钟以上（2026-09-29 现场：引擎还在传，
    //    记录已被判失败）；而 20 分钟的旧值又会落在回读中间（2026-10-13 现场：发布动作已执行、
    //    第 21 轮回读被 kill，记录判超时且无从回读）。
    const timedOut = Number.isNaN(startedAt) || Date.now() - startedAt > PUBLISH_TASK_BUDGET_MS
    if (dead || timedOut) {
      // 只写失败状态不够：worker 还在跑时，会继续占着账号（用户重试即并发抢号）——这里连带
      // 终止进程树；进程已死这条没有可杀的东西，kill 是空操作，两条收尸路径保持一致。
      killPublishWorker(taskDir)
      const failed: PublishState = {
        ...state,
        status: 'failed',
        // 统一为"可能已发出、先同步确认"：收尸发生在发布动作可能已执行之后，
        // 让用户直接重试会把同一条内容发两遍（DEF-240）。
        error: PUBLISH_RESULT_UNKNOWN_MESSAGE,
        finishedAt: nowIso(),
      }
      try {
        writeJson(file, failed)
      } catch {
        // 状态写失败仅影响下次轮询，仍返回失败结果
      }
      return failed
    }
  }
  return state
}

export type CoverResult = { ok: true; urls: string[] } | { ok: false; error: string }

/** 用 AI 笔记标题生成品牌封面卡（图文笔记发布用的媒体素材），返回资产 URL。 */
export async function generateNoteCover(deps: Deps, title: string, subtitle: string, count: number): Promise<CoverResult> {
  const taskId = uid('cover')
  const taskDir = join(deps.dataRoot, 'platform-login', 'cover', taskId)
  mkdirSync(taskDir, { recursive: true })
  const uploads = join(deps.dataRoot, 'uploads')
  mkdirSync(uploads, { recursive: true })
  const outFiles: string[] = []
  for (let i = 0; i < count; i++) {
    outFiles.push(join(uploads, uid('cover') + '.png'))
  }
  writeJson(join(taskDir, 'input.json'), { title, subtitle, outFiles })
  if (!spawnWorker(['cover', taskId, taskDir], engineDir())) {
    return { ok: false, error: '封面生成引擎启动失败' }
  }
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = readJson<{ status?: string; error?: string }>(join(taskDir, 'state.json'))
    if (state?.status === 'done') {
      return { ok: true, urls: outFiles.map(file => '/bosom-friend/api/assets/file/' + encodeURIComponent(basename(file))) }
    }
    if (state?.status === 'failed') {
      return { ok: false, error: state.error ?? '封面生成失败' }
    }
    await sleep(300)
  }
  return { ok: false, error: '封面生成超时，请重试' }
}

export async function generateMediaCards(deps: Deps, cards: { title: string; subtitle: string }[]): Promise<{ urls: string[]; files: string[] } | null> {
  if (cards.length === 0) return null
  const taskId = uid('media')
  const taskDir = join(deps.dataRoot, 'platform-login', 'cover', taskId)
  mkdirSync(taskDir, { recursive: true })
  const uploads = join(deps.dataRoot, 'uploads')
  mkdirSync(uploads, { recursive: true })
  const prefix = uid('frame')
  const files: string[] = []
  for (let i = 0; i < cards.length; i++) {
    files.push(join(uploads, `${prefix}-${String(i + 1).padStart(2, '0')}.png`))
  }
  writeJson(join(taskDir, 'input.json'), { cards, outFiles: files })
  if (!spawnWorker(['cover', taskId, taskDir], engineDir())) return null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const state = readJson<{ status?: string }>(join(taskDir, 'state.json'))
    if (state?.status === 'done') {
      return {
        urls: files.map(file => '/bosom-friend/api/assets/file/' + encodeURIComponent(basename(file))),
        files,
      }
    }
    if (state?.status === 'failed') return null
    await sleep(300)
  }
  return null
}

/** 单条外部命令的执行上限（抽帧/合成这类一次性操作，正常远低于此值）。 */
const COMMAND_TIMEOUT_MS = 120_000

/**
 * 执行一条外部命令，只回报成败。
 *
 * 必须有超时：只挂 error/exit 两个分支时，进程卡住（ffmpeg 等输入 EOF、被系统挂起）
 * Promise 永不 settle，调用方的 await 一起挂住，子进程也一并泄漏。
 * 超时后 kill 掉再 resolve(false)，让调用方按"失败"继续走降级分支。
 *
 * @param exe - 可执行文件路径。
 * @param args - 参数数组（不经 shell，无解释风险）。
 * @returns 退出码为 0 时为 true；报错、超时或非 0 退出为 false。
 */
function runCommand(exe: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    const child = trackChild(spawn(exe, args, { windowsHide: true, stdio: 'ignore' }))
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, COMMAND_TIMEOUT_MS)
    child.on('error', () => { finish(false) })
    child.on('exit', code => { finish(code === 0) })
  })
}

/** 从本地视频文件抽取一帧图片，返回可访问的资产 URL；失败返回 null。 */
export async function extractVideoThumbnail(
  deps: Deps,
  videoUrl: string,
  assetId = 'thumb-' + uid('vid') + '.jpg',
): Promise<string | null> {
  const sourceId = decodeURIComponent((videoUrl.split('/').pop() ?? ''))
  // 末段是文件名，不能当路径用：%2E%2E%5C 解码后就是真实分隔符，直接 join 会越出 uploads
  // 读到目录外的任意视频文件。含分隔符或 .. 的来源一律不认。
  if (sourceId === '' || sourceId.includes('/') || sourceId.includes('\\') || sourceId.includes('..'))
    return null
  const uploadsRoot = resolve(deps.dataRoot, 'uploads')
  const source = resolve(uploadsRoot, sourceId)
  if (!source.startsWith(uploadsRoot + sep))
    return null
  if (!existsSync(source))
    return null
  const uploads = join(deps.dataRoot, 'uploads')
  mkdirSync(uploads, { recursive: true })
  const out = join(uploads, assetId)
  const ffmpeg = ffmpegExecutable()
  const ok = await runCommand(ffmpeg, [
    '-y',
    '-i', source,
    '-vf', 'thumbnail=120,scale=480:-1',
    '-frames:v', '1',
    '-q:v', '3',
    out,
  ])
  return ok && existsSync(out)
    ? '/bosom-friend/api/assets/file/' + encodeURIComponent(assetId)
    : null
}

/**
 * 用帧图片合成可播放的竖屏短视频（成熟工具 ffmpeg），按请求时长与档位/比例输出。
 *
 * @param deps - 服务端依赖（数据根）。
 * @param frameFiles - 参与合成的画面文件（本机真实路径）。
 * @param assetId - 成品落在 uploads 下的文件名。
 * @param opts - 时长与档位/画幅。
 * @param onFailure - 合不出来时接收**原因**。厂商视频失败后这是唯一的降级出口，
 *   静默返回 null 会让"没有片子"变成一句没有原因的话——2026-10-11 实测：厂商侧 503/429 之后
 *   降级合成同样没产出，而链路上看不到任何理由，用户与模型都分不清是限流还是产品缺陷。
 * @returns 成品的资产 URL；合不出来返回 null。
 */
export async function createSlideshow(
  deps: Deps,
  frameFiles: string[],
  assetId: string,
  opts: { duration?: number; resolution?: string; aspectRatio?: string } = {},
  onFailure?: (reason: string) => void,
): Promise<string | null> {
  if (frameFiles.length === 0) {
    onFailure?.('本地降级合成没有可用画面（本次生成没有产出图片素材）')
    return null
  }
  const uploads = join(deps.dataRoot, 'uploads')
  mkdirSync(uploads, { recursive: true })
  // ffmpeg 经典序列帧方案：把帧按 001.png/002.png... 排入临时目录，避免 glob 兼容性问题
  const framesDir = join(deps.dataRoot, 'platform-login', 'ffmpeg', uid('seq'))
  mkdirSync(framesDir, { recursive: true })
  const durationSeconds = Math.max(3, Math.min(180, Math.round(Number(opts.duration) || 5)))
  const frameRate = 2
  const frameCount = Math.max(2, Math.ceil(durationSeconds * frameRate))
  const repeatedFrames = Array.from(
    { length: frameCount },
    (_, index) => frameFiles[index % frameFiles.length]!,
  )
  let copied = 0
  repeatedFrames.forEach((file, i) => {
    const target = join(framesDir, String(i + 1).padStart(3, '0') + '.png')
    // 单帧复制失败要计数：全部失败时 ffmpeg 只会报"找不到输入"，
    // 真正的原因（画面文件读不到）会被它的输出盖住。
    try { copyFileSync(file, target); copied += 1 } catch { /* 失败在此计数，判据见下一个分支 */ }
  })
  if (copied === 0) {
    const reason = '本地降级合成失败：' + String(frameFiles.length) + ' 个画面文件一个都读不到'
    console.error('[SLIDESHOW_ERR] ' + reason)
    onFailure?.(reason)
    return null
  }
  const out = join(uploads, assetId)
  const targetSize = pixelFor(opts.resolution ?? '720p', opts.aspectRatio ?? '9:16')
    || pixelFor('720p', '9:16')
  const [targetWidth, targetHeight] = targetSize.split('x').map(Number)
  const vf = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`
  // 走 runFfmpeg 而不是只回成败的 runCommand：ffmpeg 把失败原因写在 stderr，
  // 吞掉它就只能说"合成失败"而说不出为什么（本节新增的 onFailure 正是为了把原因带出去）。
  const result = await runFfmpeg([
    '-y',
    '-framerate', String(frameRate),
    '-start_number', '1',
    '-i', join(framesDir, '%03d.png'),
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-t', String(durationSeconds),
    out,
  ], { timeoutMs: COMMAND_TIMEOUT_MS })
  if (!result.ok || !existsSync(out)) {
    const detail = result.output.split('\n').map(line => line.trim()).filter(line => line !== '').slice(-3).join('；').slice(0, 300)
    const reason = result.spawnFailed
      ? '本地降级合成失败：本机找不到可用的 ffmpeg（缺组件，不是内容问题）'
      : '本地降级合成失败（ffmpeg 退出异常）：' + (detail === '' ? '没有输出可读的失败信息' : detail)
    console.error('[SLIDESHOW_ERR] ' + reason + ' out=' + out + ' frames=' + String(copied))
    onFailure?.(reason)
    return null
  }
  return '/bosom-friend/api/assets/file/' + encodeURIComponent(assetId)
}

export { ENGINE_PLATFORM as SUPPORTED_LOGIN_PLATFORMS }
