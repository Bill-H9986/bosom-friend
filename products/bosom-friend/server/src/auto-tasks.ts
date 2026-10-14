/**
 * 自动任务：三类事自动检查 + 主动汇报（P3 准出判据「3 类事自动触发并主动汇报」的落点）。
 *
 * 检查的三类事，都是**用户不会主动去点、但不知道就会出事**的：
 * 1. 待接待有新增（新评论/私信）——接待引擎已把消息登记进 `reception-pending.json`，
 *    这里只把"有新增"报给用户，不替他回复；
 * 2. 发布/排期失败——记录里已经有 `errorMsg`，但用户不翻发布记录就永远不知道；
 * 3. 账号登录态失效，以及"很久没在平台侧核实过"——失效后发布与同步全部停摆。
 *
 * **拍板闸门（产品硬约束第 2 条，DEF-240 事故教训）**：
 * 自动任务**只许「查」与「报」**——只读本机数据、只写自己的账本与通知；
 * **绝不发布、删除、花钱、对外沟通，也不改用户数据**。需要动手的事一律留给用户点头。
 * 后续往这里加能力，先过这条闸门，不要"顺手替用户做了"。
 *
 * **频率与限流**：本模块**不调用任何平台**（不拉评论、不同步数据、不打开浏览器），
 * 因此不占用免费档配额；平台侧的新消息由既有接待引擎按自己的间隔（默认 10 分钟）承担。
 * 本模块只按分钟级读本机文件：默认 5 分钟一轮，首扫在启动 15 秒后。
 *
 * **同一件事只报一次**：{@link AutoTaskState.reported} 记事件指纹，报过就不再报；
 * 同一条记录再次失败（`updatedAt` 变了）或账号再次失效（`loginCheckedAt` 变了）才会再报。
 *
 * **失败不静默**：扫描抛错时写进 `state.failures` 与运行日志（stderr，内核运行日志会落盘），
 * 并把"自动检查出错"作为一条通知报给用户——同一错误每天最多一次，避免每 5 分钟刷屏。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/auto-tasks
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Deps } from './api.ts'
import { platformCatalog } from './platform-catalog.ts'
import { nowIso } from './store-helper.ts'
import {
  PUBLISH_RECORD_STATUS,
  type NotificationRecord,
  type ReceptionPendingItem,
  type ZyPublishRecord,
  type ZySocialAccount,
} from './types.ts'

/** 扫描间隔（分钟）：检查只读本机文件，分钟级即可，不必更密。 */
const DEFAULT_INTERVAL_MINUTES = 5
/** 间隔下限/上限（与接待引擎同口径的钳制）。 */
const MIN_INTERVAL_MINUTES = 1
const MAX_INTERVAL_MINUTES = 24 * 60
/** 首扫延迟：避开启动高峰（内核冷启动、排期恢复、接待引擎首轮）。 */
const FIRST_SCAN_DELAY_MS = 15_000
/** 去重账本保留期（天）：事件已经不在数据里且超过这个天数，记账就可以丢了。 */
const REPORT_KEEP_DAYS = 30
/** 本模块在 notifications.json 里最多保留多少条自己的通知。 */
const MAX_OWN_NOTIFICATIONS = 200
/** 单条通知最多列几条明细，超出只报总数。 */
const MAX_DETAIL_LINES = 3
/** 失败记录保留条数。 */
const MAX_FAILURES = 20
/**
 * 登录态"待核实"阈值（小时）。
 *
 * 与 `api.ts` 每轮语境里的口径**同源**（那里从这里导入）：同一个数字在一处定义，
 * 两处各写一份必然漂移，用户会看到"语境说 24 小时、通知说 12 小时"。
 */
export const STALE_LOGIN_HOURS = 24
/** "待核实"提醒窗口：同一账号一个窗口内最多提醒一次（避免长期不核实变成每日噪音）。 */
const STALE_REMIND_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
/** 本模块写入的通知 id 前缀：用来把"系统自动汇报"与运营公告分开管理。 */
export const AUTO_NOTIFICATION_PREFIX = 'auto-'

/** 各类事的发现数（供状态接口显示，不代表已上报）。 */
export interface AutoTaskCounts {
  /** 待接待新增条数。 */
  reception: number
  /** 未报过的发布/排期失败条数。 */
  publishFailed: number
  /** 未报过的登录态问题账号数（失效 + 待核实）。 */
  loginProblem: number
}

/**
 * 自动任务的配置、账本与自检记录。
 *
 * 落盘 `auto-task-state.json`。之所以把去重账本也落盘：进程重启后不能把已经报过的事再报一遍。
 */
export interface AutoTaskState {
  /** 自动检查开关；关掉后不再排期（用户可在自己的数据根里改这个文件）。 */
  enabled: boolean
  /** 扫描间隔（分钟），钳制在 {@link MIN_INTERVAL_MINUTES}~{@link MAX_INTERVAL_MINUTES}。 */
  intervalMinutes: number
  lastScanAt: string | null
  nextScanAt: string | null
  /** 累计扫描轮数（含失败轮）。 */
  scans: number
  lastCounts: AutoTaskCounts
  /** 去重账本：事件指纹 -> 首次汇报时刻。 */
  reported: Record<string, string>
  /** 本模块自身的失败（最近 {@link MAX_FAILURES} 条）：自动任务出错绝不静默。 */
  failures: Array<{ at: string, message: string }>
}

/** 默认状态：全新安装或文件损坏时使用。 */
export function defaultAutoTaskState(): AutoTaskState {
  return {
    enabled: true,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    lastScanAt: null,
    nextScanAt: null,
    scans: 0,
    lastCounts: { reception: 0, publishFailed: 0, loginProblem: 0 },
    reported: {},
    failures: [],
  }
}

/** 发现项分组：一件事合并成一条通知，不按条刷屏。 */
export type AutoTaskGroup = 'reception' | 'publish-failed' | 'login-invalid' | 'login-stale'

/** 一条发现项：`key` 是去重指纹，`line` 是面向用户的明细。 */
export interface AutoTaskFinding {
  group: AutoTaskGroup
  key: string
  line: string
}

/** 检查的输入（全部来自本机已落盘的数据，不触发任何平台动作）。 */
export interface AutoTaskInput {
  pending: readonly ReceptionPendingItem[]
  records: readonly ZyPublishRecord[]
  accounts: readonly ZySocialAccount[]
}

/** 分组标题（带数量）。 */
const GROUP_TITLES: Record<AutoTaskGroup, (count: number) => string> = {
  reception: count => '自动检查：' + String(count) + ' 条新评论/私信等你接待',
  'publish-failed': count => '自动检查：' + String(count) + ' 条内容没有发出去',
  'login-invalid': count => '自动检查：' + String(count) + ' 个账号登录态失效',
  'login-stale': count => '自动检查：' + String(count) + ' 个账号很久没核实过登录态',
}

/** 分组提示：告诉用户下一步该去哪一页（动手仍由他点）。 */
const GROUP_HINTS: Record<AutoTaskGroup, string> = {
  reception: '到「客服接待」处理这些消息；这里只提醒，不会替你回复。',
  'publish-failed': '到「发布记录」看完整失败原因；重发或改期都要你自己点。',
  'login-invalid': '到「添加频道/账号管理」重新扫码登录；失效期间发布与同步都会失败。',
  'login-stale': '到「账号管理」点一次同步即可核实登录态（只读拉取，不会发布任何内容）。',
}

/** 平台代码 → 中文名。platformCatalog 会扫引擎目录，构建一次即可，不能每轮都扫。 */
let platformNames: Map<string, string> | undefined

/**
 * 取平台的中文名。
 *
 * @param code - 平台代码（如 `douyin`）。
 * @returns 中文名；未收录时原样返回代码，空代码返回"未知平台"。
 */
function platformName(code: string): string {
  if (platformNames === undefined) {
    platformNames = new Map(platformCatalog().map(item => [item.platform, item.name]))
  }
  return platformNames.get(code) ?? (code === '' ? '未知平台' : code)
}

/** 短哈希：事件指纹 → 通知 id 的稳定后缀（同一批事件生成同一个 id）。 */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

/** 面向用户的本地时刻（YYYY-MM-DD HH:mm），与通知中心其它条目同一形态。 */
function localStamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return String(at.getFullYear()) + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate())
    + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())
}

/**
 * 去掉引擎日志里的 ANSI 颜色码。
 *
 * 失败原文来自引擎 stdout，带 `\u001b[38;2;…m` 这类颜色控制符；
 * 直接进通知会在界面上显示成乱码（现场发不出去的记录就是这么写的）。
 *
 * @param text - 原始文本。
 * @returns 去掉颜色码后的文本。
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI 转义以 ESC(0x1b) 开头，这是它的定义
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
}

/** 单行摘要：压掉换行与多余空白，超长截断。 */
function excerpt(text: string, limit: number): string {
  const flat = stripAnsi(text).replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/** 账号的显示名。 */
function nicknameOf(account: ZySocialAccount): string {
  const name = String(account.nickname ?? '').trim()
  return name === '' ? '（未设置昵称）' : name
}

/** 一条待接待的明细行。 */
function receptionLine(item: ReceptionPendingItem): string {
  const kind = item.kind === 'dm' ? '私信' : '评论'
  const who = (item.kind === 'dm' ? String(item.peerName ?? '') : String(item.username ?? '')).trim()
  const work = excerpt(String(item.workTitle ?? ''), 20)
  const text = excerpt(String(item.commentText ?? ''), 40)
  const head = platformName(String(item.platform ?? '')) + ' · ' + kind
    + (work === '' ? '' : '（' + work + '）') + '：' + (text === '' ? '（没有文字）' : text)
  return who === '' ? head : head + '——来自 ' + who
}

/** 一条发布/排期失败的明细行。 */
function publishFailureLine(record: ZyPublishRecord): string {
  const title = excerpt(String(record.title ?? ''), 24)
  const reason = excerpt(String(record.errorMsg ?? ''), 80)
  return platformName(String(record.accountType ?? '')) + '《' + (title === '' ? '未命名内容' : title) + '》：'
    + (reason === '' ? '平台没有给出失败原因' : reason)
}

/**
 * 距离上次在平台侧核实登录态过了多少小时（口径只此一处，自动任务与每轮语境共用）。
 *
 * 未来时刻（时钟回拨，或别的写入方给了超前的时间戳）按"刚刚核实过"算：拿它去减会得到负数，
 * 而负数会被当成"从未核实过"，白报一次"待核实"——2026-10-12 函数级验证实测到的边界。
 *
 * @param loginCheckedAt - 账号上的核实时刻（ISO）；缺省表示从未核实过。
 * @param nowMs - 当前毫秒时间戳。
 * @returns 小时数；从未核实过返回 -1。
 */
export function staleHoursOf(loginCheckedAt: string | undefined, nowMs: number): number {
  const checked = Date.parse(String(loginCheckedAt ?? ''))
  if (!Number.isFinite(checked)) return -1
  return Math.max(0, Math.floor((nowMs - checked) / 3_600_000))
}

/** 一条登录态问题的明细行（失效或待核实）。 */
function loginLine(account: ZySocialAccount, hours: number): string {
  const head = platformName(String(account.type ?? '')) + ' · ' + nicknameOf(account) + '：'
  if (hours >= 0) return head + '平台判定需要重新登录（' + excerpt(String(account.loginNote ?? ''), 60) + '）'
  return head + '平台判定需要重新登录' + (String(account.loginNote ?? '').trim() === ''
    ? ''
    : '（' + excerpt(String(account.loginNote ?? ''), 60) + '）')
}

/**
 * 盘点当前**存在**的三类事（不做去重，不写盘）。
 *
 * 纯函数：输入都是已读出的数据，便于诊断与复用；不碰平台、不写文件。
 *
 * @param input - 待接待 / 发布记录 / 账号三份数据。
 * @param nowMs - 当前毫秒时间戳（用于登录态时效判定）。
 * @returns 当前所有候选发现项。
 */
export function collectAutoTaskCandidates(input: AutoTaskInput, nowMs: number): AutoTaskFinding[] {
  const findings: AutoTaskFinding[] = []
  // 1. 待接待：只算还没处理完的（pending / 缺省），已成功或已跳过的不是"新增"。
  for (const item of input.pending) {
    const status = item.status ?? 'pending'
    if (status !== 'pending') continue
    findings.push({ group: 'reception', key: 'reception:' + item.id, line: receptionLine(item) })
  }
  // 2. 发布/排期失败：已取消、预演都不算失败。
  for (const record of input.records) {
    if (record.status !== PUBLISH_RECORD_STATUS.FAILED) continue
    findings.push({
      group: 'publish-failed',
      key: 'publish-failed:' + String(record.id) + ':' + String(record.updatedAt ?? ''),
      line: publishFailureLine(record),
    })
  }
  // 3. 登录态：失效是硬问题；"很久没核实过"是它的前兆（不声称失效，只说待核实）。
  for (const account of input.accounts) {
    const id = String(account.id ?? '')
    if (id === '') continue
    if (account.loginState === 'invalid') {
      findings.push({
        group: 'login-invalid',
        key: 'login-invalid:' + id + ':' + String(account.loginCheckedAt ?? ''),
        line: loginLine(account, -1),
      })
      continue
    }
    // 产品侧已停用的账号不提醒（与每轮语境的口径一致：它本来就不在可用范围）。
    if (account.status !== 1) continue
    const hours = staleHoursOf(account.loginCheckedAt, nowMs)
    if (hours >= 0 && hours < STALE_LOGIN_HOURS) continue
    const window = Math.floor(nowMs / STALE_REMIND_WINDOW_MS)
    const stale = hours < 0
      ? '从绑定起就没在平台侧核实过登录态'
      : String(hours) + ' 小时没有在平台侧核实过登录态'
    findings.push({
      group: 'login-stale',
      key: 'login-stale:' + id + ':' + String(window),
      line: platformName(String(account.type ?? '')) + ' · ' + nicknameOf(account) + '：' + stale
        + '，发布或同步前建议先核实一次',
    })
  }
  return findings
}

/**
 * 从候选里挑出还没报过的（去重）。
 *
 * @param state - 自动任务状态（只读 `reported`）。
 * @param candidates - {@link collectAutoTaskCandidates} 的结果。
 * @returns 本次需要新报的发现项。
 */
export function selectNewFindings(
  state: AutoTaskState,
  candidates: readonly AutoTaskFinding[],
): AutoTaskFinding[] {
  return candidates.filter(finding => state.reported[finding.key] === undefined)
}

/** 按分组把发现项拼成通知（一类一条）。 */
export function buildAutoTaskNotifications(
  findings: readonly AutoTaskFinding[],
  atIso: string,
): NotificationRecord[] {
  const groups = new Map<AutoTaskGroup, AutoTaskFinding[]>()
  for (const finding of findings) {
    const bucket = groups.get(finding.group)
    if (bucket === undefined) groups.set(finding.group, [finding])
    else bucket.push(finding)
  }
  const stamp = localStamp(new Date(atIso))
  const created: NotificationRecord[] = []
  for (const [group, items] of groups) {
    const lines = items.slice(0, MAX_DETAIL_LINES).map(item => '· ' + item.line)
    if (items.length > MAX_DETAIL_LINES) {
      lines.push('· 另有 ' + String(items.length - MAX_DETAIL_LINES) + ' 条同类，到对应页面看完整清单')
    }
    lines.push('')
    lines.push('—— 自动检查 ' + stamp + ' 发现。' + GROUP_HINTS[group])
    created.push({
      id: AUTO_NOTIFICATION_PREFIX + group + '-' + shortHash(items.map(item => item.key).join('|')),
      type: 'system',
      title: GROUP_TITLES[group](items.length),
      content: lines.join('\n'),
      time: stamp,
    })
  }
  return created
}

/** 判断一条通知是不是本模块写的。 */
function isOwnNotification(item: NotificationRecord): boolean {
  return typeof item.id === 'string' && item.id.startsWith(AUTO_NOTIFICATION_PREFIX)
}

/**
 * 把新通知写进 notifications.json。
 *
 * 只动本模块自己写的那些（`auto-` 前缀），运营公告与更新日志一条都不碰；
 * 自己的记录超过 {@link MAX_OWN_NOTIFICATIONS} 条时裁掉最旧的。
 *
 * @param deps - 产品依赖。
 * @param created - 本次要新增的通知（新的在最前）。
 */
function appendAutoTaskNotifications(deps: Deps, created: readonly NotificationRecord[]): void {
  if (created.length === 0) return
  const existing = deps.store.files.notifications.load()
  const mine = existing.filter(item => isOwnNotification(item))
  const others = existing.filter(item => !isOwnNotification(item))
  const fresh = created.filter(item => !mine.some(one => one.id === item.id))
  deps.store.files.notifications.save([...fresh, ...mine].slice(0, MAX_OWN_NOTIFICATIONS).concat(others))
}

/** 归一化读出的状态：文件损坏/旧版本字段缺失时按默认值兜底，绝不因一份坏文件让自动任务停摆。 */
export function readAutoTaskState(deps: Deps): AutoTaskState {
  const base = defaultAutoTaskState()
  const raw = deps.store.files.autoTasks.load() as Partial<AutoTaskState> | null | undefined
  if (raw === null || raw === undefined || typeof raw !== 'object') return base
  const interval = Number(raw.intervalMinutes)
  const counts = raw.lastCounts
  const reported = raw.reported
  const failures = raw.failures
  return {
    enabled: raw.enabled !== false,
    intervalMinutes: Number.isFinite(interval)
      ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.floor(interval)))
      : base.intervalMinutes,
    lastScanAt: typeof raw.lastScanAt === 'string' ? raw.lastScanAt : null,
    nextScanAt: typeof raw.nextScanAt === 'string' ? raw.nextScanAt : null,
    scans: Number.isFinite(Number(raw.scans)) ? Math.max(0, Math.floor(Number(raw.scans))) : 0,
    lastCounts: {
      reception: Number(counts?.reception ?? 0) || 0,
      publishFailed: Number(counts?.publishFailed ?? 0) || 0,
      loginProblem: Number(counts?.loginProblem ?? 0) || 0,
    },
    reported: (reported !== null && typeof reported === 'object' && !Array.isArray(reported))
      ? Object.fromEntries(
          Object.entries(reported as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : {},
    failures: Array.isArray(failures)
      ? failures
          .filter((item): item is { at: string, message: string } =>
            typeof item === 'object' && item !== null
            && typeof (item as { at?: unknown }).at === 'string'
            && typeof (item as { message?: unknown }).message === 'string')
          .slice(0, MAX_FAILURES)
      : [],
  }
}

/** 落盘状态。 */
function saveAutoTaskState(deps: Deps, state: AutoTaskState): void {
  deps.store.files.autoTasks.save(state)
}

/** 把各类发现折算成状态接口用的计数。 */
function countsOf(findings: readonly AutoTaskFinding[]): AutoTaskCounts {
  const counts: AutoTaskCounts = { reception: 0, publishFailed: 0, loginProblem: 0 }
  for (const finding of findings) {
    if (finding.group === 'reception') counts.reception += 1
    else if (finding.group === 'publish-failed') counts.publishFailed += 1
    else counts.loginProblem += 1
  }
  return counts
}

/**
 * 清掉已经不可能再提醒的记账。
 *
 * 事件还在（`liveKeys` 里）就一直留着——那正是"同一件事只报一次"的依据；
 * 事件没了（记录被删、账号解绑）且超过保留期，记账才可以丢。
 *
 * @param state - 自动任务状态（就地修改）。
 * @param liveKeys - 当前仍存在的事件指纹。
 * @param nowMs - 当前毫秒时间戳。
 */
function pruneReported(state: AutoTaskState, liveKeys: ReadonlySet<string>, nowMs: number): void {
  for (const [key, at] of Object.entries(state.reported)) {
    if (liveKeys.has(key)) continue
    const parsed = Date.parse(at)
    if (Number.isNaN(parsed) || nowMs - parsed > REPORT_KEEP_DAYS * 24 * 60 * 60 * 1000) {
      delete state.reported[key]
    }
  }
}

/** 一次扫描的结果。 */
export interface AutoTaskScanResult {
  /** 是否真的跑完一轮（开关关掉或抛错时为 false）。 */
  scanned: boolean
  /** 本次新报的通知条数。 */
  reported: number
  /** 本次各类发现数。 */
  counts: AutoTaskCounts
  /** 扫描失败的原文；成功时缺省。 */
  error?: string
}

/**
 * 记一次自动任务自身的失败。
 *
 * 失败绝不静默：写运行日志（stderr → 内核运行日志落盘）、写 `failures` 账本，
 * 并把"自动检查出错"报给用户；同一错误每天最多报一次，免得故障期间每 5 分钟刷一条。
 *
 * @param deps - 产品依赖。
 * @param state - 自动任务状态（就地修改）。
 * @param message - 失败原文。
 * @param at - 当前 ISO 时刻。
 * @param nowMs - 当前毫秒时间戳。
 */
function recordAutoTaskFailure(
  deps: Deps,
  state: AutoTaskState,
  message: string,
  at: string,
  nowMs: number,
): void {
  console.error('[auto-task] 检查失败：' + message)
  state.failures = [{ at, message: excerpt(message, 300) }, ...state.failures].slice(0, MAX_FAILURES)
  state.scans += 1
  state.lastScanAt = at
  state.nextScanAt = new Date(nowMs + state.intervalMinutes * 60_000).toISOString()
  const day = new Date(nowMs).toISOString().slice(0, 10)
  const key = 'failure:' + shortHash(message) + ':' + day
  if (state.reported[key] === undefined) {
    state.reported[key] = at
    appendAutoTaskNotifications(deps, [{
      id: AUTO_NOTIFICATION_PREFIX + 'failure-' + shortHash(key),
      type: 'system',
      title: '自动检查自己出错了',
      content: '· ' + excerpt(message, 200) + '\n\n（这是自动检查本身的故障，不是你的内容出了问题；'
        + '原文已记进运行日志，下一轮会自动重试。）',
      time: localStamp(new Date(at)),
    }])
  }
  saveAutoTaskState(deps, state)
}

/**
 * 跑一轮自动检查：盘点三类事 → 去重 → 写通知 → 记账。
 *
 * 只读本机数据、只写本模块自己的账本与通知（拍板闸门，见模块头注释）。
 *
 * @param deps - 产品依赖。
 * @returns 本轮结果（含失败原文，调用方不得吞掉）。
 */
export function runAutoTaskScan(deps: Deps): AutoTaskScanResult {
  const state = readAutoTaskState(deps)
  const nowMs = Date.now()
  const at = nowIso()
  if (!state.enabled) return { scanned: false, reported: 0, counts: state.lastCounts }
  try {
    const candidates = collectAutoTaskCandidates({
      pending: deps.store.files.receptionPending.load(),
      records: deps.store.files.records.load(),
      accounts: deps.store.files.accounts.load(),
    }, nowMs)
    const findings = selectNewFindings(state, candidates)
    const notifications = buildAutoTaskNotifications(findings, at)
    appendAutoTaskNotifications(deps, notifications)
    for (const finding of findings) state.reported[finding.key] = at
    state.lastCounts = countsOf(findings)
    state.scans += 1
    state.lastScanAt = at
    state.nextScanAt = new Date(nowMs + state.intervalMinutes * 60_000).toISOString()
    pruneReported(state, new Set(candidates.map(finding => finding.key)), nowMs)
    saveAutoTaskState(deps, state)
    if (notifications.length > 0) {
      console.error('[auto-task] 主动汇报 ' + String(notifications.length) + ' 条：'
        + notifications.map(item => item.title).join('；'))
    }
    return { scanned: true, reported: notifications.length, counts: state.lastCounts }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordAutoTaskFailure(deps, state, message, at, nowMs)
    return { scanned: false, reported: 0, counts: state.lastCounts, error: message }
  }
}

let scanTimer: ReturnType<typeof setTimeout> | undefined
let scanGeneration = 0

/** 排定下一轮扫描；开关关掉后不再排期。 */
function scheduleNextScan(deps: Deps, delayMs: number): void {
  const generation = ++scanGeneration
  if (scanTimer !== undefined) clearTimeout(scanTimer)
  scanTimer = setTimeout(() => {
    if (generation !== scanGeneration) return
    runAutoTaskScan(deps)
    const state = readAutoTaskState(deps)
    if (state.enabled) scheduleNextScan(deps, state.intervalMinutes * 60_000)
  }, Math.max(1_000, delayMs))
  scanTimer.unref?.()
}

/** 启动自动任务（进程内单例；与接待引擎同层，卸载时由 {@link stopAutoTasks} 收掉）。 */
export function startAutoTasks(deps: Deps): void {
  if (scanTimer !== undefined) return
  const state = readAutoTaskState(deps)
  if (!state.enabled) {
    console.error('[auto-task] 自动检查已在数据根里关闭（auto-task-state.json 的 enabled=false），不排期')
    return
  }
  scheduleNextScan(deps, FIRST_SCAN_DELAY_MS)
  console.error('[auto-task] 自动检查已启动：间隔 ' + String(state.intervalMinutes) + ' 分钟，首扫 '
    + String(Math.round(FIRST_SCAN_DELAY_MS / 1000)) + ' 秒后')
}

/** 服务插件卸载时停止定时器。 */
export function stopAutoTasks(): void {
  if (scanTimer !== undefined) {
    clearTimeout(scanTimer)
    scanTimer = undefined
  }
  scanGeneration += 1
}

/** 状态接口用的只读视图。 */
export interface AutoTaskStatusView {
  enabled: boolean
  intervalMinutes: number
  lastScanAt: string | null
  nextScanAt: string | null
  scans: number
  lastCounts: AutoTaskCounts
  /** 最近一次失败原文；没失败过时为空串。 */
  lastError: string
  /** 去重账本里已经报过多少件事。 */
  reportedCount: number
  /** 已报事件里最近的一条时刻。 */
  lastReportedAt: string | null
  /** 本模块发出的最近通知（通知中心里看到的就是这些）。 */
  notifications: Array<{ id: string, title: string, content: string, time: string }>
  /** 状态文件位置：用户自己也能打开核对。 */
  stateFile: string
}

/**
 * 读自动任务的状态（只读，不触发扫描）。
 *
 * @param deps - 产品依赖。
 * @returns 状态视图；通知列表取本模块最近 5 条。
 */
export function autoTaskStatus(deps: Deps): AutoTaskStatusView {
  const state = readAutoTaskState(deps)
  const times = Object.values(state.reported).sort()
  const notifications = deps.store.files.notifications.load()
    .filter(item => isOwnNotification(item))
    .slice(0, 5)
    .map(item => ({ id: item.id, title: item.title, content: item.content, time: item.time }))
  return {
    enabled: state.enabled,
    intervalMinutes: state.intervalMinutes,
    lastScanAt: state.lastScanAt,
    nextScanAt: state.nextScanAt,
    scans: state.scans,
    lastCounts: state.lastCounts,
    lastError: state.failures[0]?.message ?? '',
    reportedCount: Object.keys(state.reported).length,
    lastReportedAt: times.length === 0 ? null : (times[times.length - 1] ?? null),
    notifications,
    stateFile: join(deps.dataRoot, 'auto-task-state.json'),
  }
}
