/**
 * 平台登录/发布引擎适配器：DSH 后端进程与 vendored social-auto-upload worker 进程之间的桥。
 * 登录/发布业务逻辑全部在开源引擎（MIT）内，本模块只做：进程拉起、状态文件读写、
 * 二维码等待、登录结果落盘为账号。
 * @module @deepseek-ai/dsh-bosom-friend-server/platform-login
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Deps } from './api.ts'
import type { ZySocialAccount } from './types.ts'
import { enginePythonExe, engineRoot } from './engine-root.ts'
import { pixelFor } from './image-ratio.ts'
import { nowIso, uid } from './store-helper.ts'
import { engineKeyForPlatform, platformCatalog } from './platform-catalog.ts'
import { trackChild } from './platform-processes.ts'
import { ffmpegExecutable } from './ffmpeg.ts'

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
interface LoginState {
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
}

const QR_WAIT_MS = 60_000
const QR_TTL_MS = 600_000

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
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function spawnWorker(args: string[], cwd: string): boolean {
  const exe = pythonExe()
  if (!existsSync(exe) || !existsSync(join(engineDir(), 'worker.py'))) return false
  const child = trackChild(spawn(exe, [join(engineDir(), 'worker.py'), ...args], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }))
  child.unref()
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
    const friendly = /Locator\.click|Timeout|Call log|playwright|spinner-props|login-box/.test(raw)
      ? '二维码加载失败或已过期，请点击“重试”重新获取二维码'
      : raw
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

/** 拉起真实发布 worker：标题/描述/话题 + 本地媒体文件 + 目标账号 cookie。 */
export function startPlatformPublish(deps: Deps, taskId: string, input: {
  platform: string
  type: string
  title: string
  desc: string
  topics: string[]
  mediaFiles: string[]
  loginCookie: string
  isDraft?: boolean
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
  })
  const launched = spawnWorker(['publish', taskId, taskDir], engineDir())
  if (!launched) return { ok: false, error: '平台发布引擎启动失败' }
  writeJson(join(taskDir, 'state.json'), { taskId, status: 'starting', startedAt: nowIso() } satisfies PublishState)
  return { ok: true, taskId }
}

/** 读取发布结果（供发布调度器在完成/失败时回写记录）。 */
export function getPublishState(deps: Deps, taskId: string): PublishState | undefined {
  const file = join(deps.dataRoot, 'platform-login', 'publish', taskId, 'state.json')
  const state = readJson<PublishState>(file)
  if (state?.status === 'starting' || state?.status === 'uploading') {
    const startedAt = state.startedAt ? Date.parse(state.startedAt) : 0
    if (Number.isNaN(startedAt) || Date.now() - startedAt > 5 * 60_000) {
      const failed: PublishState = {
        ...state,
        status: 'failed',
        error: '平台发布引擎长时间未返回结果，已自动终止，请检查账号与平台页面后重试',
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

function runCommand(exe: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    const child = trackChild(spawn(exe, args, { windowsHide: true, stdio: 'ignore' }))
    child.on('error', () => { resolve(false) })
    child.on('exit', code => { resolve(code === 0) })
  })
}

/** 从本地视频文件抽取一帧图片，返回可访问的资产 URL；失败返回 null。 */
export async function extractVideoThumbnail(
  deps: Deps,
  videoUrl: string,
  assetId = 'thumb-' + uid('vid') + '.jpg',
): Promise<string | null> {
  const sourceId = decodeURIComponent((videoUrl.split('/').pop() ?? ''))
  const source = join(deps.dataRoot, 'uploads', sourceId)
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

/** 用帧图片合成可播放的竖屏短视频（成熟工具 ffmpeg），按请求时长与档位/比例输出。 */
export async function createSlideshow(
  deps: Deps,
  frameFiles: string[],
  assetId: string,
  opts: { duration?: number; resolution?: string; aspectRatio?: string } = {},
): Promise<string | null> {
  if (frameFiles.length === 0) return null
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
  repeatedFrames.forEach((file, i) => {
    const target = join(framesDir, String(i + 1).padStart(3, '0') + '.png')
    try { copyFileSync(file, target) } catch { /* 单帧失败交给 ffmpeg 报错 */ }
  })
  const out = join(uploads, assetId)
  const ffmpeg = ffmpegExecutable()
  const targetSize = pixelFor(opts.resolution ?? '720p', opts.aspectRatio ?? '9:16')
    || pixelFor('720p', '9:16')
  const [targetWidth, targetHeight] = targetSize.split('x').map(Number)
  const vf = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`
  const ok = await runCommand(ffmpeg, [
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
  ])
  return ok && existsSync(out) ? '/bosom-friend/api/assets/file/' + encodeURIComponent(assetId) : null
}

export { ENGINE_PLATFORM as SUPPORTED_LOGIN_PLATFORMS }
