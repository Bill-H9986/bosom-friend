/**
 * 评论/私信只读采集引擎。
 *
 * 铁律：任何平台业务动作（回复评论/发送私信）都不允许在后端自动执行。
 * 本引擎只做只读采集（列表/未读），登记待办到 reception-pending.json，
 * “是否回复、回复什么、何时发送”必须由用户在前端页面点击触发；
 * 后端接口对写操作只能执行“前端显式发起”的任务，且结果必须返回前端展示。
 * @module @deepseek-ai/dsh-bosom-friend-server/reception-engine
 */

import type { Deps } from './api.ts'
import {
  getInteractionState,
  newInteractionTaskId,
  startPlatformInteraction,
} from './platform-interactions.ts'
import { perfTier } from './perf.ts'
import { nowIso, uid } from './store-helper.ts'
import {
  matchReceptionRules,
  normalizeReceptionText,
  type ReceptionMatchInput,
  type ReceptionMatchOutcome,
} from './reception-rules.ts'
import type {
  ReceptionAccountStatus,
  ReceptionPendingItem,
  ReceptionRule,
  ReceptionStatus,
} from './types.ts'

export { matchReceptionRules, normalizeReceptionText }
export type { ReceptionMatchInput, ReceptionMatchOutcome }

const DEFAULT_SEEN_WINDOW_MINUTES = 7 * 24 * 60
const DEFAULT_COOLDOWN_MINUTES = 30
const DEFAULT_MAX_PENDING_PER_ROUND = 3

/**
 * 默认轮询间隔（分钟）。
 *
 * 每轮都要拉起平台引擎读列表，是服务端最贵的后台动作；低配机器默认拉长到 20 分钟。
 * 用户显式配置过的值优先，这里只是"没配过时的默认"。
 */
function defaultIntervalMinutes(): number {
  return perfTier().caps.receptionIntervalMinutes
}
const MAX_TASK_WAIT_MS = 150_000

/** 接待引擎运行时配置（未配置时使用默认值，配置值始终为具体数字）。 */
export interface ReceptionEngineConfig {
  intervalMinutes: number
  maxRepliesPerRound: number
  seenWindowMinutes: number
  cooldownMinutes: number
  maxPendingPerRound: number
}

interface InteractionComment {
  key?: string
  commentText?: string
  username?: string
  hasReply?: boolean
  workId?: string
}

interface InteractionConversation {
  sessionId?: string
  peerName?: string
  lastText?: string
}

interface RoundBudget {
  remaining: number
}

let engineTimer: ReturnType<typeof setTimeout> | undefined
let engineScheduleGeneration = 0
let roundRunning = false

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(Number(value))))
    : fallback
}

function readConfig(status: ReceptionStatus | undefined): ReceptionEngineConfig {
  const config = status?.config
  const intervalMinutes = clampInt(config?.intervalMinutes, defaultIntervalMinutes(), 1, 1440)
  const seenWindowMinutes = clampInt(
    config?.seenWindowMinutes,
    DEFAULT_SEEN_WINDOW_MINUTES,
    1,
    60 * 24 * 30,
  )
  const cooldownMinutes = clampInt(config?.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES, 0, 60 * 24)
  const legacyZeroNeedsDefault = config?.maxPendingPerRound === undefined
    && config?.maxRepliesPerRound === 0
  const maxPendingPerRound = clampInt(
    legacyZeroNeedsDefault
      ? DEFAULT_MAX_PENDING_PER_ROUND
      : config?.maxPendingPerRound ?? config?.maxRepliesPerRound,
    DEFAULT_MAX_PENDING_PER_ROUND,
    0,
    100,
  )
  return {
    intervalMinutes,
    maxRepliesPerRound: maxPendingPerRound,
    seenWindowMinutes,
    cooldownMinutes,
    maxPendingPerRound,
  }
}

function withinMinutes(value: string | number | undefined, maxMinutes: number): boolean {
  if (value === undefined || value === '' || maxMinutes <= 0) return false
  const ts = typeof value === 'number' ? value : Date.parse(value)
  if (Number.isNaN(ts)) return false
  const elapsed = Date.now() - ts
  return elapsed >= 0 && elapsed < maxMinutes * 60_000
}

function pendingKey(
  item: Pick<
    ReceptionPendingItem,
    'kind' | 'platform' | 'accountId' | 'workId' | 'commentKey' | 'commentText' | 'sessionId' | 'peerName'
  >,
): string {
  return [
    item.kind,
    item.platform,
    item.accountId,
    item.workId ?? '',
    item.commentKey ?? '',
    item.sessionId ?? '',
    item.peerName ?? '',
    item.commentText ?? '',
  ].join('|')
}

function rememberSeen(deps: Deps, key: string): void {
  const seen = deps.store.files.receptionSeen.load()
  seen[key] = nowIso()
  const all = Object.entries(seen)
  if (all.length > 5000) {
    const sorted = all.sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    for (const [oldKey] of sorted.slice(0, all.length - 5000)) delete seen[oldKey]
  }
  deps.store.files.receptionSeen.save(seen)
}

function pruneSeen(deps: Deps): void {
  const seen = deps.store.files.receptionSeen.load()
  const config = readConfig(deps.store.files.receptionStatus.load())
  const next: Record<string, string> = {}
  for (const [key, at] of Object.entries(seen)) {
    if (withinMinutes(at, config.seenWindowMinutes)) next[key] = at
  }
  deps.store.files.receptionSeen.save(next)
}

function migrateReceptionPending(deps: Deps): void {
  const pending = deps.store.files.receptionPending.load()
  let changed = false
  for (const item of pending) {
    if (item.status === undefined) {
      item.status = 'pending'
      changed = true
    }
  }
  if (changed) deps.store.files.receptionPending.save(pending)
}

/**
 * 规则匹配（与 routes-content 共用同一实现；命中模板即生成最终回复）。
 * @param files - 后端持久化文件集合。
 * @param input - 消息、平台、账号范围。
 */
export function matchReception(
  files: Deps['store']['files'],
  input: ReceptionMatchInput,
): ReceptionMatchOutcome {
  return matchReceptionRules(files.receptionRules.load(), input)
}

async function waitInteraction(
  deps: Deps,
  taskId: string,
): Promise<{ status?: string; data?: unknown; error?: string }> {
  const deadline = Date.now() + MAX_TASK_WAIT_MS
  while (Date.now() < deadline) {
    const state = getInteractionState(deps, taskId)
    if (state?.status === 'done' || state?.status === 'failed') return state
    await sleep(1000)
  }
  return { status: 'failed', error: '互动任务超时（页面操作过慢或平台无响应）' }
}

async function runList(
  deps: Deps,
  input: Parameters<typeof startPlatformInteraction>[2],
): Promise<unknown> {
  const taskId = newInteractionTaskId()
  const started = startPlatformInteraction(deps, taskId, input)
  if (!started.ok) return { ok: false, message: started.error }
  const result = await waitInteraction(deps, taskId)
  if (result.status === 'failed') return { ok: false, message: result.error ?? '读取失败' }
  return result.data ?? { ok: false, message: '平台未返回数据' }
}

function accountWorks(
  deps: Deps,
  accountId: string,
): { workId: string; title?: string; createTime?: string }[] {
  const seen = new Map<string, { workId: string; title?: string; createTime?: string }>()
  for (const rec of deps.store.files.records.load()) {
    if (rec.accountId !== accountId || typeof rec.platformWorkId !== 'string' || rec.platformWorkId === '') continue
    seen.set(rec.platformWorkId, {
      workId: rec.platformWorkId,
      ...(typeof rec.title === 'string' ? { title: rec.title } : {}),
      createTime: rec.publishTime,
    })
  }
  for (const row of deps.store.files.metrics.load()) {
    if (row.accountId !== accountId || typeof row.workId !== 'string' || row.workId === '') continue
    if (!seen.has(row.workId)) seen.set(row.workId, { workId: row.workId })
  }
  return [...seen.values()].slice(0, 6)
}

function recountPending(deps: Deps, accountId: string): {
  commentsPending: number
  commentsReplied: number
  commentsFailed: number
  dmsPending: number
  dmsReplied: number
  dmsFailed: number
} {
  const rows = deps.store.files.receptionPending.load()
    .filter(item => item.accountId === accountId)
  const count = (kind: 'comment' | 'dm', status?: ReceptionPendingItem['status']): number =>
    rows.filter(item => item.kind === kind && (status === undefined
      ? item.status === 'pending' || item.status === 'processing'
      : item.status === status)).length
  const failed = (kind: 'comment' | 'dm'): number =>
    rows.filter(item => item.kind === kind && item.status === 'failed' && item.matched === true).length
  return {
    commentsPending: count('comment', 'pending'),
    commentsReplied: count('comment', 'succeeded'),
    commentsFailed: failed('comment'),
    dmsPending: count('dm', 'pending'),
    dmsReplied: count('dm', 'succeeded'),
    dmsFailed: failed('dm'),
  }
}

/**
 * 登记一条“待前端处理”的互动。
 *
 * 同一平台 key 在 seenWindowMinutes 内不重复登记；失败项可在 cooldownMinutes 后重新打开，
 * 已成功或已跳过项保持结果，直到窗口过期后才会重新进入采集。
 */
function registerPending(
  deps: Deps,
  item: Omit<ReceptionPendingItem, 'id' | 'at' | 'status'>,
): boolean {
  const pending = deps.store.files.receptionPending.load()
  const config = readConfig(deps.store.files.receptionStatus.load())
  const seen = deps.store.files.receptionSeen.load()
  const key = pendingKey(item)
  const existing = pending.find(row => pendingKey(row) === key)
  const seenAt = seen[key]

  if (existing !== undefined) {
    if (existing.status === 'pending' || existing.status === undefined) return false
    const inSeenWindow = withinMinutes(existing.handledAt ?? existing.at, config.seenWindowMinutes)
    const inCooldown = existing.status === 'failed'
      && withinMinutes(existing.handledAt ?? existing.at, config.cooldownMinutes)
    if (inSeenWindow || inCooldown) return false
    existing.status = 'pending'
    existing.at = nowIso()
    delete existing.handledAt
    delete existing.error
    deps.store.files.receptionPending.save(pending)
    rememberSeen(deps, key)
    return true
  }
  if (withinMinutes(seenAt, config.seenWindowMinutes)) return false
  pending.unshift({ ...item, id: uid('pend'), at: nowIso(), status: 'pending' })
  deps.store.files.receptionPending.save(pending.slice(0, 500))
  rememberSeen(deps, key)
  return true
}

async function processComments(
  deps: Deps,
  account: { id: string; type: string; nickname?: string },
  status: ReceptionAccountStatus,
  budget: RoundBudget,
): Promise<void> {
  const works = accountWorks(deps, account.id)
  let found = 0
  let pending = 0
  for (const work of works) {
    if (budget.remaining <= 0) {
      status.message = '本轮已达账号登记上限，其余评论将在下一轮继续扫描'
      break
    }
    const listed = (await runList(deps, {
      op: 'comments_list',
      platform: account.type,
      accountId: account.id,
      workId: work.workId,
      workTitle: work.title ?? '',
      createTime: work.createTime ?? '',
    })) as { ok?: boolean; comments?: InteractionComment[]; message?: string }
    if (listed.ok !== true) {
      status.status = 'risk'
      status.message = listed.message ?? '评论读取失败'
      continue
    }
    for (const comment of listed.comments ?? []) {
      if (comment.hasReply === true) continue
      found++
      const outcome = matchReception(deps.store.files, {
        message: comment.commentText ?? '',
        platform: account.type,
        accountId: account.id,
      })
      const key = pendingKey({
        kind: 'comment',
        platform: account.type,
        accountId: account.id,
        workId: work.workId,
        commentKey: comment.key ?? '',
        commentText: comment.commentText ?? '',
        sessionId: '',
        peerName: '',
      })
      // 未命中规则的消息同样登记待办：规则是「优先模板」，不是「唯一入口」。
      // 丢弃未命中消息会让待办恒为空，客户点名的接待功能等于不存在。
      if ((comment.commentText ?? '').trim() === '') {
        rememberSeen(deps, key)
        continue
      }
      const added = budget.remaining > 0 && registerPending(deps, {
        kind: 'comment',
        platform: account.type,
        accountId: account.id,
        workId: work.workId,
        workTitle: work.title ?? '',
        commentKey: comment.key ?? '',
        commentText: comment.commentText ?? '',
        username: comment.username ?? '',
        matched: outcome.matched,
        ...(outcome.rule?.name !== undefined ? { ruleName: outcome.rule.name } : {}),
        ...(outcome.reply !== undefined && outcome.reply !== '' ? { reply: outcome.reply } : {}),
      })
      if (added) {
        budget.remaining--
        pending++
      } else {
        rememberSeen(deps, key)
      }
    }
  }
  status.commentsFound = found
  status.commentsPending = pending
}

async function processDms(
  deps: Deps,
  account: { id: string; type: string; nickname?: string },
  status: ReceptionAccountStatus,
  budget: RoundBudget,
): Promise<void> {
  const listed = (await runList(deps, {
    op: 'dm_list',
    platform: account.type,
    accountId: account.id,
  })) as { ok?: boolean; conversations?: InteractionConversation[]; message?: string }
  if (listed.ok !== true) {
    if (status.status === 'scanned') status.status = 'risk'
    status.message = listed.message ?? '私信读取失败'
    return
  }
  let found = 0
  let pending = 0
  for (const conv of listed.conversations ?? []) {
    const text = conv.lastText ?? ''
    if (text.trim() === '') continue
    found++
    const outcome = matchReception(deps.store.files, {
      message: text,
      platform: account.type,
      accountId: account.id,
    })
      const key = pendingKey({
        kind: 'dm',
        platform: account.type,
      accountId: account.id,
      workId: '',
      commentKey: '',
      commentText: text,
        sessionId: conv.sessionId ?? '',
        peerName: conv.peerName ?? '',
      })
      // 同上：私信未命中规则也要进待办，否则 7×24 轮询扫到的消息全部被静默吞掉。
      const added = budget.remaining > 0 && registerPending(deps, {
        kind: 'dm',
        platform: account.type,
        accountId: account.id,
        sessionId: conv.sessionId ?? '',
        peerName: conv.peerName ?? '',
        commentText: text,
        matched: outcome.matched,
        ...(outcome.rule?.name !== undefined ? { ruleName: outcome.rule.name } : {}),
        ...(outcome.reply !== undefined && outcome.reply !== '' ? { reply: outcome.reply } : {}),
      })
      if (added) {
        budget.remaining--
        pending++
      } else {
        rememberSeen(deps, key)
      }
  }
  status.dmsFound = found
  status.dmsPending = pending
}

/** 执行一轮真实接待轮询（评论 + 私信），回写监控状态。 */
export async function runReceptionRound(deps: Deps): Promise<ReceptionStatus> {
  if (roundRunning) return deps.store.files.receptionStatus.load()
  roundRunning = true
  migrateReceptionPending(deps)
  pruneSeen(deps)
  const previous = deps.store.files.receptionStatus.load()
  const config = readConfig(previous)
  const status: ReceptionStatus = {
    ...previous,
    config,
    running: true,
    accounts: [],
  }
  deps.store.files.receptionStatus.save(status)
  try {
    const accounts = deps.store.files.accounts.load().filter(account => account.status === 1)
    for (const account of accounts) {
      const accountStatus: ReceptionAccountStatus = {
        accountId: account.id,
        platform: account.type,
        nickname: account.nickname,
        status: typeof account.loginCookie === 'string' && account.loginCookie !== '' ? 'scanned' : 'no-login',
        message: typeof account.loginCookie === 'string' && account.loginCookie !== '' ? 'Cookie 有效，已纳入真实接待轮询' : '未完成真实登录',
        at: Date.now(),
      }
      if (accountStatus.status !== 'no-login') {
        const budget: RoundBudget = { remaining: config.maxPendingPerRound }
        try {
          if (account.type === 'douyin' || account.type === 'xhs') {
            await processComments(deps, account, accountStatus, budget)
            await processDms(deps, account, accountStatus, budget)
          } else {
            accountStatus.status = 'unsupported'
            accountStatus.message = '该平台接待通道待接入'
          }
        } catch (error) {
          accountStatus.status = 'error'
          accountStatus.message = error instanceof Error ? error.message : String(error)
        }
        const counts = recountPending(deps, account.id)
        accountStatus.commentsPending = counts.commentsPending
        accountStatus.commentsReplied = counts.commentsReplied
        accountStatus.commentsFailed = counts.commentsFailed
        accountStatus.dmsPending = counts.dmsPending
        accountStatus.dmsReplied = counts.dmsReplied
        accountStatus.dmsFailed = counts.dmsFailed
      }
      status.accounts.push(accountStatus)
    }
    status.rounds += 1
    status.lastPollAt = nowIso()
    status.nextPollAt = new Date(
      Date.now() + config.intervalMinutes * 60_000,
    ).toISOString()
  } finally {
    status.running = false
    deps.store.files.receptionStatus.save(status)
    roundRunning = false
  }
  return status
}

function kick(deps: Deps): void {
  void runReceptionRound(deps).catch(() => {
    roundRunning = false
  })
}

function scheduleNext(deps: Deps, delayMs: number): void {
  const generation = ++engineScheduleGeneration
  if (engineTimer !== undefined) clearTimeout(engineTimer)
  engineTimer = setTimeout(() => {
    if (generation !== engineScheduleGeneration) return
    kick(deps)
    const config = readConfig(deps.store.files.receptionStatus.load())
    scheduleNext(deps, config.intervalMinutes * 60_000)
  }, Math.max(15_000, delayMs))
  engineTimer.unref?.()
}

/** 启动 7×24 接待引擎（进程内单例；后台异步轮询，不阻塞 HTTP）。 */
export function startReceptionEngine(deps: Deps): void {
  if (engineTimer !== undefined) return
  migrateReceptionPending(deps)
  const status = deps.store.files.receptionStatus.load()
  if (!status.enabled) return
  rescheduleReceptionEngine(deps)
}

/** 服务插件卸载时停止接待定时器，避免退出后继续轮询平台。 */
export function stopReceptionEngine(): void {
  if (engineTimer !== undefined) {
    clearTimeout(engineTimer)
    engineTimer = undefined
  }
  engineScheduleGeneration += 1
  roundRunning = false
}

/** 配置变更后重新排定下次轮询。 */
export function rescheduleReceptionEngine(deps: Deps): void {
  const status = deps.store.files.receptionStatus.load()
  if (!status.enabled) {
    if (engineTimer !== undefined) {
      clearTimeout(engineTimer)
      engineTimer = undefined
    }
    return
  }
  const config = readConfig(status)
  const next = Date.parse(status.nextPollAt ?? '')
  const delay = Number.isNaN(next) || next <= Date.now()
    ? config.intervalMinutes * 60_000
    : next - Date.now()
  scheduleNext(deps, delay)
}

/** 更新接待引擎配置并立即重排定时器。 */
export function updateReceptionConfig(
  deps: Deps,
  patch: {
    intervalMinutes?: number
    seenWindowMinutes?: number
    cooldownMinutes?: number
    maxPendingPerRound?: number
  },
): ReceptionEngineConfig {
  const status = deps.store.files.receptionStatus.load()
  const config = readConfig(status)
  const next: ReceptionEngineConfig = {
    intervalMinutes: clampInt(patch.intervalMinutes, config.intervalMinutes, 1, 1440),
    maxRepliesPerRound: config.maxRepliesPerRound,
    seenWindowMinutes: clampInt(
      patch.seenWindowMinutes ?? config.seenWindowMinutes,
      config.seenWindowMinutes ?? DEFAULT_SEEN_WINDOW_MINUTES,
      1,
      60 * 24 * 30,
    ),
    cooldownMinutes: clampInt(
      patch.cooldownMinutes ?? config.cooldownMinutes,
      config.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES,
      0,
      60 * 24,
    ),
    maxPendingPerRound: clampInt(
      patch.maxPendingPerRound ?? config.maxPendingPerRound,
      config.maxPendingPerRound ?? DEFAULT_MAX_PENDING_PER_ROUND,
      0,
      100,
    ),
  }
  next.maxRepliesPerRound = next.maxPendingPerRound
  status.config = next
  status.nextPollAt = null
  deps.store.files.receptionStatus.save(status)
  rescheduleReceptionEngine(deps)
  return next
}

/** 前端显式发起回复后回写待办生命周期（不执行任何平台发送）。 */
export function markReceptionPending(
  deps: Deps,
  id: string,
  status: NonNullable<ReceptionPendingItem['status']>,
  error?: string,
  sentText?: string,
): ReceptionPendingItem | undefined {
  const pending = deps.store.files.receptionPending.load()
  const item = pending.find(row => row.id === id)
  if (item === undefined) return undefined
  item.status = status
  item.handledAt = nowIso()
  if (error !== undefined && error !== '') item.error = error
  else delete item.error
  if (sentText !== undefined && sentText !== '') item.sentText = sentText
  deps.store.files.receptionPending.save(pending)
  return { ...item }
}

/**
 * 手动立即执行一轮（前端「立即轮询」按钮）。
 * 已经在跑一轮时直接返回 false——调用方必须如实告诉用户「没触发」，不能让按钮看起来生效了其实什么都没做。
 *
 * @returns 这次调用是否真的启动了一轮轮询。
 */
export function triggerReceptionNow(deps: Deps): boolean {
  if (roundRunning) return false
  void runReceptionRound(deps)
  return true
}

/** 供测试/诊断读取当前规则集合类型（保留导出，避免纯类型断言）。 */
export type ReceptionRuleView = ReceptionRule
