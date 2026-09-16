/**
 * AI/规则回复记录：把「哪个客户说了什么 → AI 回了什么 → 平台结果」沉淀为可回溯历史，
 * 供「全局监控」按客户收纳展示。
 *
 * 记录在回复任务发起时写入（status=sending），成功/失败一律由平台互动任务的状态文件核对
 * （getInteractionState），不接受前端上报的成功状态，避免出现"假成功"。
 * 落盘文件：reception-replies.json（主键 id，客户维度聚合键 customerKey）。
 * @module @deepseek-ai/dsh-bosom-friend-server/reception-replies
 */

import type { Deps } from './api.ts'
import { getInteractionState } from './platform-interactions.ts'
import { nowIso, uid } from './store-helper.ts'
import type { ReceptionConversationSnapshot, ReceptionReplyRecord } from './types.ts'

/** 记录上限：超出后丢弃最旧记录，避免数据文件随时间无限增长。 */
const MAX_RECORDS = 2000

/** 发起回复后仍未拿到平台结果的判定上限；超过即记为失败，不再无限等待。 */
const REPLY_RESULT_TIMEOUT_MS = 10 * 60_000

/** 一条回复记录的发起输入（字段与 POST interactions/reply 一一对应）。 */
export interface ReceptionReplyInput {
  taskId: string
  platform: string
  accountId: string
  kind: 'comment' | 'dm'
  commentText?: string
  username?: string
  sessionId?: string
  peerName?: string
  workId?: string
  workTitle?: string
  replyText: string
  ruleName?: string
}

/** 客户标识片段（评论者或私信会话）。 */
export interface ReceptionCustomerRef {
  username?: string
  sessionId?: string
  peerName?: string
}

/**
 * 计算客户唯一键。
 *
 * @param kind - 互动类型：comment 按评论者聚合，dm 按会话聚合。
 * @param input - 平台返回的客户标识片段。
 * @returns 客户唯一键；标识缺失时返回带类型前缀的空键，保证同一账号下不会误并不同客户。
 */
export function receptionCustomerKey(kind: 'comment' | 'dm', input: ReceptionCustomerRef): string {
  const raw = kind === 'comment' ? input.username : (input.sessionId ?? input.peerName)
  return `${kind}:${(raw ?? '').trim()}`
}

/**
 * 计算客户显示名。
 *
 * @param kind - 互动类型。
 * @param input - 平台返回的客户标识片段。
 * @returns 有名字时用名字，缺失时返回中性称呼（匿名评论者/未命名会话）。
 */
export function receptionCustomerName(kind: 'comment' | 'dm', input: ReceptionCustomerRef): string {
  const raw = kind === 'comment' ? input.username : (input.peerName ?? input.sessionId)
  const name = (raw ?? '').trim()
  if (name !== '') return name
  return kind === 'comment' ? '匿名评论者' : '未命名会话'
}

/**
 * 写入一条回复记录（发起即记录，成功与否由 reconcileReceptionReplies 核对平台任务回写）。
 *
 * @param deps - 产品依赖（数据根与存储）。
 * @param input - 发起回复的输入。
 * @returns 新写入的记录。
 */
export function recordReceptionReply(deps: Deps, input: ReceptionReplyInput): ReceptionReplyRecord {
  const records = deps.store.files.receptionReplies.load()
  const account = deps.store.files.accounts.load().find(a => a.id === input.accountId)
  const record: ReceptionReplyRecord = {
    id: uid('reply'),
    taskId: input.taskId,
    at: nowIso(),
    platform: input.platform,
    accountId: input.accountId,
    kind: input.kind,
    customerKey: receptionCustomerKey(input.kind, input),
    customerName: receptionCustomerName(input.kind, input),
    sourceText: input.commentText ?? '',
    replyText: input.replyText,
    status: 'sending',
    ...(account === undefined ? {} : { accountNickname: account.nickname }),
    ...(input.workId === undefined || input.workId === '' ? {} : { workId: input.workId }),
    ...(input.workTitle === undefined || input.workTitle === '' ? {} : { workTitle: input.workTitle }),
    ...(input.ruleName === undefined || input.ruleName === '' ? {} : { ruleName: input.ruleName }),
  }
  records.unshift(record)
  deps.store.files.receptionReplies.save(records.slice(0, MAX_RECORDS))
  return record
}

/**
 * 核对未完成记录：读取平台互动任务状态，回写成功/失败与失败原因。
 *
 * @param deps - 产品依赖（数据根与存储）。
 * @returns 核对后的全部记录（新的在前）。
 */
export function reconcileReceptionReplies(deps: Deps): ReceptionReplyRecord[] {
  const records = deps.store.files.receptionReplies.load()
  let changed = false
  for (const record of records) {
    if (record.status !== 'sending') continue
    const state = record.taskId === undefined ? undefined : getInteractionState(deps, record.taskId)
    if (state?.status === 'done') {
      record.status = 'succeeded'
      record.finishedAt = state.finishedAt ?? nowIso()
      changed = true
      continue
    }
    if (state?.status === 'failed') {
      record.status = 'failed'
      record.error = state.error ?? '平台未确认回复成功'
      record.finishedAt = state.finishedAt ?? nowIso()
      changed = true
      continue
    }
    const startedAt = Date.parse(record.at)
    if (Number.isFinite(startedAt) && Date.now() - startedAt > REPLY_RESULT_TIMEOUT_MS) {
      record.status = 'failed'
      record.error = '互动任务超时未返回结果，请检查账号登录态后重试'
      record.finishedAt = nowIso()
      changed = true
    }
  }
  if (changed) deps.store.files.receptionReplies.save(records)
  return records
}

/** 按客户聚合后的会话摘要（前端左栏列表用）。 */
export interface ReceptionCustomerThread {
  customerKey: string
  customerName: string
  platform: string
  accountId: string
  accountNickname?: string
  kind: 'comment' | 'dm'
  lastAt: string
  total: number
  succeeded: number
  failed: number
  sending: number
  lastSource: string
  lastReply: string
}

/** 回复记录筛选条件（全部可选，空值表示不筛选）。 */
export interface ReceptionReplyQuery {
  platform?: string
  accountId?: string
  kind?: 'comment' | 'dm'
  status?: ReceptionReplyRecord['status']
  /** 关键词：同时匹配客户名、原文与回复内容。 */
  keyword?: string
  limit?: number
}

/**
 * 读取回复记录并生成按客户聚合的会话摘要。
 *
 * @param deps - 产品依赖（数据根与存储）。
 * @param query - 筛选条件（平台/账号/类型/状态/关键词/条数上限）。
 * @returns 命中总数、筛选后的记录（新的在前）与按客户聚合的摘要（最近互动在前）。
 */
export function listReceptionReplies(
  deps: Deps,
  query: ReceptionReplyQuery = {},
): { total: number; records: ReceptionReplyRecord[]; customers: ReceptionCustomerThread[] } {
  const all = reconcileReceptionReplies(deps)
  const keyword = (query.keyword ?? '').trim().toLowerCase()
  const limit = query.limit === undefined ? 300 : Math.max(1, Math.min(MAX_RECORDS, query.limit))
  const records = all.filter((record) => {
    if (query.platform !== undefined && query.platform !== '' && record.platform !== query.platform) return false
    if (query.accountId !== undefined && query.accountId !== '' && record.accountId !== query.accountId) return false
    if (query.kind !== undefined && record.kind !== query.kind) return false
    if (query.status !== undefined && record.status !== query.status) return false
    if (keyword !== '') {
      const haystack = `${record.customerName}\n${record.sourceText}\n${record.replyText}`.toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  }).slice(0, limit)

  const threads = new Map<string, ReceptionCustomerThread>()
  for (const record of records) {
    const existing = threads.get(record.customerKey)
    if (existing === undefined) {
      threads.set(record.customerKey, {
        customerKey: record.customerKey,
        customerName: record.customerName,
        platform: record.platform,
        accountId: record.accountId,
        kind: record.kind,
        lastAt: record.at,
        total: 1,
        succeeded: record.status === 'succeeded' ? 1 : 0,
        failed: record.status === 'failed' ? 1 : 0,
        sending: record.status === 'sending' ? 1 : 0,
        lastSource: record.sourceText,
        lastReply: record.replyText,
        ...(record.accountNickname === undefined ? {} : { accountNickname: record.accountNickname }),
      })
      continue
    }
    existing.total += 1
    if (record.status === 'succeeded') existing.succeeded += 1
    if (record.status === 'failed') existing.failed += 1
    if (record.status === 'sending') existing.sending += 1
  }
  const customers = [...threads.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
  return { total: all.length, records, customers }
}

/**
 * 把平台读回的原对话快照挂到指定记录上（按记录 id 定位，找不到返回 undefined）。
 *
 * @param deps - 产品依赖（数据根与存储）。
 * @param replyId - 回复记录 id。
 * @param snapshot - 平台原对话快照（内容来自引擎任务，不接受前端编造）。
 * @returns 更新后的记录；记录不存在时为 undefined。
 */
export function attachReceptionConversation(
  deps: Deps,
  replyId: string,
  snapshot: ReceptionConversationSnapshot,
): ReceptionReplyRecord | undefined {
  const records = deps.store.files.receptionReplies.load()
  const record = records.find(row => row.id === replyId)
  if (record === undefined) return undefined
  record.conversation = snapshot
  deps.store.files.receptionReplies.save(records)
  return record
}

/**
 * 清空全部回复记录。
 *
 * @param deps - 产品依赖（数据根与存储）。
 * @returns 被清空的记录条数。
 */
export function clearReceptionReplies(deps: Deps): number {
  const count = deps.store.files.receptionReplies.load().length
  deps.store.files.receptionReplies.save([])
  return count
}
