/**
 * 生成任务停滞判定：把"永远转圈"的生成记录判成失败，并保留已经生成好的文案。
 *
 * 现场 DEF-083：一次图文生成在 2026-09-18T04:17:55Z 之后再无进展，直到 04:55 采集时仍停在
 * generating（38 分钟）。前端只能一直转圈，用户既拿不到已经生成好的文案，也不知道发生了什么。
 *
 * 判定依据是记录自身的 updatedAt：正常路径上每次推进（文案完成、媒体开始、媒体结束）都会刷新它，
 * 媒体生成期间还有心跳定时刷新。因此"updatedAt 长时间不动"就是"任务已经死了"的可靠信号，
 * 与"任务很慢但还活着"可以区分开。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/generation-watchdog
 */

import { videoMediaLatencyBudgetMs } from './video-duration.ts'

/** 按任务类型的停滞预算：超过即判定失败。 */
const STALL_BUDGET_MS = {
  /** 图文：文案 + 若干张图片；实测单张数十秒，给足 10 分钟。 */
  'image-text': 10 * 60_000,
  /** 视频：厂商单条成片实测 33s~4m07s，给足 20 分钟。 */
  'video': 20 * 60_000,
} as const

/** 未声明类型的任务按图文预算处理。 */
const DEFAULT_BUDGET_MS = STALL_BUDGET_MS['image-text']

/**
 * 媒体步骤的硬预算：到点必须收尾，不看 updatedAt。
 *
 * 为什么必须有这一层：只看 updatedAt 的看门狗会被"进程还活着、某个 await 永不返回"绕过去
 * —— 心跳还在刷时间，任务就永远显得"很慢但还活着"。现场那条卡了 38 分钟的记录正是这种形态。
 * 因此媒体步骤本身带绝对截止时间。
 *
 * 预算为什么按档位推导：15 分钟这个定值只够一次下单（实测单片 33s~4m07s），
 * 而 30 秒档位要下 7 片、1 分钟档位要下 15 片（见 video-duration 的规划）。定值预算会在
 * 成片**已经拼好躺在盘上**的时候把它判成超时（DEF-107 现场：AI_VID_COMPOSE actual=30.02，
 * 记录却写"超时"）。所以视频预算由片段数 × 单片实测上限推出，定值只作下限兜底。
 */
const MEDIA_BUDGET_MS = {
  'image-text': 8 * 60_000,
  video: 15 * 60_000,
} as const

/** 停滞判定只关心这几个字段。 */
export interface GenerationRecord {
  id: string
  status: string
  createdAt: string
  updatedAt: string
  errorMessage?: string
  response?: { title?: string, description?: string } | undefined
  request?: { kind?: string, duration?: number } | undefined
}

/**
 * 取某类任务的停滞预算。
 *
 * 视频且带档位时按该档位的媒体预算加一段兜底余量：心跳每 60 秒刷一次 updatedAt，
 * 看门狗判的是"连心跳都停了"，所以它必须比媒体截止时间更宽，否则媒体还在正常拼接就被判失败。
 *
 * @param kind - 任务类型（image-text / video）。
 * @param duration - 视频档位（秒）；缺省或非视频时用定值预算。
 * @returns 预算毫秒数。
 */
export function generationBudgetMs(kind: string | undefined, duration?: number): number {
  if (kind !== 'video')
    return kind === 'image-text' ? STALL_BUDGET_MS['image-text'] : DEFAULT_BUDGET_MS
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0)
    return STALL_BUDGET_MS.video
  return Math.max(STALL_BUDGET_MS.video, mediaBudgetMs('video', { duration }) + STALL_BUDGET_MS.video)
}

/**
 * 取某类任务媒体步骤的预算。
 *
 * @param kind - 任务类型（image-text / video）。
 * @param options - 视频档位与可选的部署上限；图文忽略。
 * @param options.duration - 视频档位（秒）。
 * @param options.maxMs - 部署给的上限（默认 4 小时）：防止配置错误把任务无限挂住。
 * @returns 预算毫秒数。
 */
export function mediaBudgetMs(
  kind: string | undefined,
  options?: { duration?: number, maxMs?: number },
): number {
  if (kind !== 'video')
    return MEDIA_BUDGET_MS['image-text']
  const duration = options?.duration
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0)
    return MEDIA_BUDGET_MS.video
  const derived = videoMediaLatencyBudgetMs(duration)
  const maxMs = options?.maxMs
  const ceiling = maxMs === undefined || !Number.isFinite(maxMs) || maxMs <= 0
    ? DEFAULT_MEDIA_BUDGET_MAX_MS
    : maxMs
  return Math.max(MEDIA_BUDGET_MS.video, Math.min(derived, ceiling))
}

/** 媒体预算的部署默认上限：4 小时。 */
export const DEFAULT_MEDIA_BUDGET_MAX_MS = 4 * 60 * 60_000

/**
 * 媒体超时的收尾文案。
 *
 * @param budgetMs - 生效的媒体预算。
 * @param hasResponse - 记录里是否已经有生成好的文案。
 * @returns 面向用户的一句话，说明卡在哪一步、以及已有产出还在。
 */
export function mediaTimeoutMessage(budgetMs: number, hasResponse: boolean): string {
  const minutes = Math.max(1, Math.round(budgetMs / 60_000))
  const head = '媒体生成超时：超过 ' + minutes + ' 分钟没有结果（厂商无响应或下载卡住）。'
  return hasResponse
    ? head + '文字/脚本已保留，可直接使用或稍后重新生成媒体。'
    : head + '请重新生成。'
}

/**
 * 已停滞多久（毫秒）。
 *
 * updatedAt 缺失或不可解析时回退 createdAt；两者都没有则视为刚创建（不判停滞），
 * 宁可漏判一次，也不要把一条正常任务误杀。
 *
 * @param gen - 生成记录。
 * @param now - 当前毫秒时间戳。
 * @returns 停滞毫秒数。
 */
export function stalledForMs(gen: GenerationRecord, now: number): number {
  const updated = Date.parse(gen.updatedAt)
  const created = Date.parse(gen.createdAt)
  const anchor = Number.isNaN(updated) ? created : updated
  if (Number.isNaN(anchor))
    return 0
  return Math.max(0, now - anchor)
}

/**
 * 找出应当判失败的停滞任务。
 *
 * @param generations - 全部生成记录。
 * @param now - 当前毫秒时间戳。
 * @returns 停滞且仍在 generating 的记录。
 */
export function findStalledGenerations(generations: readonly GenerationRecord[], now: number): GenerationRecord[] {
  return generations.filter((gen) => {
    if (gen.status !== 'generating')
      return false
    return stalledForMs(gen, now) > generationBudgetMs(gen.request?.kind, gen.request?.duration)
  })
}

/**
 * 停滞任务的失败文案。
 *
 * @param stalledMs - 停滞毫秒数。
 * @param hasResponse - 记录里是否已经有生成好的文案。
 * @returns 面向用户的一句话，说明发生了什么、以及已有产出还在。
 */
export function stalledErrorMessage(stalledMs: number, hasResponse: boolean): string {
  const minutes = Math.max(1, Math.round(stalledMs / 60_000))
  const head = '生成超时：任务已停滞 ' + minutes + ' 分钟没有进展（服务可能中断或厂商无响应）。'
  return hasResponse
    ? head + '已经生成的文案已保留，可直接使用或重新生成。'
    : head + '请重新生成。'
}

/**
 * 把停滞的生成记录就地判成失败（保留 response 与 points）。
 *
 * @param generations - 全部生成记录，就地修改。
 * @param now - 当前毫秒时间戳。
 * @param nowIso - 生成 updatedAt 的当前时间字符串。
 * @returns 被改动的记录（调用方据此落盘与记账）。
 */
export function markStalledGenerations(
  generations: GenerationRecord[],
  now: number,
  nowIso: string,
): GenerationRecord[] {
  const stalled = findStalledGenerations(generations, now)
  for (const gen of stalled) {
    const stalledMs = stalledForMs(gen, now)
    gen.status = 'failed'
    gen.errorMessage = stalledErrorMessage(stalledMs, gen.response?.description !== undefined || gen.response?.title !== undefined)
    gen.updatedAt = nowIso
  }
  return stalled
}
