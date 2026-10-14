/**
 * 用发布后的**真实表现**给样本打分（ADR-004 附录 P1）。
 *
 * 为什么要它：复利飞轮（质量语境）此前只能靠用户手点五星才能转起来——
 * 用户不点，账本里就永远是「评分 0」，下一次的上下文里也就没有范例。
 * 而产品手里本来就有一条更硬的信号：**这条内容发出去之后平台给了什么数据**。
 *
 * 口径（三条，都是为了不把弱信号说成强信号）：
 * 1. **只在同一账号内比**：不同平台的量级不可比，同一平台不同账号的粉丝基数也不可比；
 * 2. **只有跑赢的才给分**（前 25% 给 5 分，前 50% 给 4 分），跑输的**不打分**——
 *    发布表现受封面、发布时间、平台分发影响，不全是文案的功劳，拿一次发布给内容判死刑是错的；
 * 3. **不覆盖用户自己打的分**：用户看过的产出才是判断，机器只看得到数字。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/sample-rating
 */

import { type KnowledgeState } from './knowledge-distill.ts'
import { PUBLISH_RECORD_STATUS, type ZyPublishRecord } from './types.ts'
import type { Deps } from './api.ts'

/** 至少要有这么多条**有数据**的作品，排名才有意义；不够就一条都不评。 */
export const MIN_RANKED_WORKS = 5
/** 跑进前这个比例给 5 分。 */
const TOP_FRACTION = 0.25
/** 跑进前这个比例给 4 分（再往后不给分）。 */
const SECOND_FRACTION = 0.5

/**
 * 一条作品的表现分。
 *
 * 优先播放量；平台没给播放量时退回点赞（两者都是平台真值时才用得上）。
 * 缺失或全 0 表示「还没采到」，不是「没人看」——那种一律返回 undefined。
 *
 * @param engagement - 记录上的互动数据。
 * @returns 表现分；没有可用真值时返回 undefined。
 */
export function performanceScore(engagement: ZyPublishRecord['engagement']): number | undefined {
  if (engagement === undefined) return undefined
  const views = engagement.viewCount
  if (typeof views === "number" && views > 0) return views
  const likes = engagement.likeCount
  if (typeof likes === "number" && likes > 0) return likes
  return undefined
}

/**
 * 同一账号内，这个表现分该给几分。
 *
 * @param scores - 该账号全部**有数据**作品的表现分。
 * @param score - 本条作品的表现分。
 * @returns 5 / 4 / undefined（没跑赢就不打分）。
 */
export function engagementRatingOf(scores: number[], score: number): number | undefined {
  if (scores.length < MIN_RANKED_WORKS) return undefined
  const better = scores.filter(item => item > score).length
  const fraction = (better + 1) / scores.length
  if (fraction <= TOP_FRACTION) return 5
  if (fraction <= SECOND_FRACTION) return 4
  return undefined
}

/** 这次打分的结果（给日志与判据用）。 */
export interface SampleRatingResult {
  /** 参与排名的作品数（有数据、已发布、未下架）。 */
  rankedWorks: number
  /** 真的改了评分的样本数。 */
  rated: number
}

/**
 * 按真实表现给样本打分：作品 → 它的来源草稿 → 那条草稿上的对象动作样本。
 *
 * @param deps - 共享依赖（发布记录、知识库账本）。
 * @returns 参与排名的作品数与真正改了评分的样本数。
 */
export function rateSamplesFromEngagement(deps: Deps): SampleRatingResult {
  const records = deps.store.files.records.load()
  const knowledge = deps.store.files.knowledge.load() as KnowledgeState
  const samples = knowledge.distillations ?? []
  if (samples.length === 0) return { rankedWorks: 0, rated: 0 }

  const published = records.filter(record =>
    record.status === PUBLISH_RECORD_STATUS.PUBLISHED && record.removedOnPlatform !== true)
  const scoresByAccount = new Map<string, number[]>()
  for (const record of published) {
    const score = performanceScore(record.engagement)
    if (score === undefined) continue
    const key = accountKeyOf(record)
    scoresByAccount.set(key, [...(scoresByAccount.get(key) ?? []), score])
  }

  let rated = 0
  const next = samples.map((sample) => {
    // 用户打过的分是判断，机器只看得到数字：用户评过的一律不动。
    if (sample.ratingSource === "user") return sample
    if (sample.objectKind !== "draft" || sample.objectId === undefined) return sample
    const record = published.find(item => item.draftId === sample.objectId)
    if (record === undefined) return sample
    const score = performanceScore(record.engagement)
    if (score === undefined) return sample
    const rating = engagementRatingOf(scoresByAccount.get(accountKeyOf(record)) ?? [], score)
    if (rating === undefined) return sample
    if (sample.rating === rating && sample.ratingSource === "engagement") return sample
    rated += 1
    return { ...sample, rating, ratingSource: "engagement" as const }
  })

  if (rated > 0) {
    knowledge.distillations = next
    deps.store.files.knowledge.save(knowledge)
  }
  return { rankedWorks: published.filter(item => performanceScore(item.engagement) !== undefined).length, rated }
}

/**
 * 作品属于哪个账号（同账号内才可比）。
 *
 * @param record - 发布记录。
 * @returns 账号键；没有 accountId 时退回平台类型（至少不跨平台比）。
 */
function accountKeyOf(record: ZyPublishRecord): string {
  const accountId = String(record.accountId ?? "")
  return accountId !== "" ? accountId : "platform:" + String(record.accountType ?? "")
}
