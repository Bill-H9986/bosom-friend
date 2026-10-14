/**
 * 视频时长的产品档位与「单片 / 多片合成」规划。
 *
 * 官方规格（agnes.ts 已逐条核对）把**单次下单**的时长锁在 seconds = "4"~"12"：
 * 超出区间官方直接 400，所以 30 秒 / 1 分钟这类更长时长**不可能靠一次调用拿到**。
 * 产品要支持它们，只有一条路：按官方允许的片段长度多次下单，再把片段拼成成片
 * （复用长视频那条已跑通的合成链路 composeSegments）。
 *
 * 本模块只做纯计算，不碰网络与磁盘：
 * - 给定目标时长，算出每个片段该要多少秒（每个都落在官方 4~12 内）；
 * - 给出「成片时长与所选档位不一致时怎么收敛」的判定（裁齐或补足）。
 *
 * 为什么把规划独立成模块：现场出现过「选了 10 秒、拿到的却是 12 秒」这类参数没起作用的投诉，
 * 而规划错了在端到端里极难发现（合成成功、时长不对）。规划必须可离线逐条验收。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/video-duration
 */

import { AGNES_VIDEO_SECONDS_MAX, AGNES_VIDEO_SECONDS_MIN } from './agnes.ts'

/** 产品在界面上摆出的单次下单档位（全部落在官方 4~12 内）。 */
export const PRODUCT_VIDEO_GEARS: readonly number[] = [4, 5, 6, 8, 10, 12]

/**
 * 多片段合成档位。
 *
 * 60 秒为什么不用「12 秒 × 5」：官方单片上限 12 秒，五片 12 秒同样能凑 60 秒，
 * 但产品口径是「4 秒一个小片段」（与长视频每镜节奏一致，转场与口播节奏都可控），
 * 因此统一按 4 秒切片，只有收尾片段按余数取值（仍落 4~12 内）。
 */
/**
 * 多片段合成档位（秒）：30 秒到 5 分钟。
 *
 * 产品口径是「内容创作一个入口，时长决定走单次还是分段」——长片不再是另一个板块，
 * 而是同一入口里更长的档位。每档的诚实耗时由 {@link estimateMinutes} 算给界面。
 */
export const COMPOSED_VIDEO_GEARS: readonly number[] = [30, 60, 90, 120, 180, 300]

/** 片段长度的产品基准：4 秒。 */
export const CLIP_SECONDS = 4

/**
 * 官方视频模型的**请求频率上限**（免费档，次/分钟）。
 *
 * 依据 Agnes 官方《模型目录》（AgnesAI-Labs/AgnesAI-Models 的 `MODEL_CATALOG.md`，
 * 2026-06-28 版）：Video models / Free 档 **Public Request RPM = 2、Actual Executable RPM = 1**；
 * Enterprise 2/2；Token Plan 6/5。也就是说免费档**每分钟只有 1 个镜头能真正开始生成**——
 * 这是每片至少间隔 60 秒的硬约束，分镜排得再快、下单也要排队。
 * 这是**官方规格**而不是可调项：它由服务端调度决定，产品侧只能按它给诚实的预估。
 */
export const VIDEO_FREE_TIER_RPM = 1

/**
 * 官方订阅的视频额度上限（秒/天）。
 *
 * 依据同一份《模型目录》的订阅配额表：Starter / Plus / Pro 三档的 `agnes-video-v2.0`
 * 额度**都是 500 秒/天**。也就是说每天最多出 5 条 90 秒的片子；额度耗尽时厂商会回 402，
 * 界面必须提前告诉用户，而不是让他跑到一半才发现。
 */
export const VIDEO_DAILY_QUOTA_SECONDS = 500

/**
 * 厂商单片的实测耗时区间（秒）。
 *
 * 依据：2026-09 现场实测 4~7 秒成片单片耗时 33s / 125s / 160s，另有一次 4m07s。
 * 用它给界面一个诚实的预估，而不是让用户对着进度条猜。
 */
export const CLIP_LATENCY_SECONDS_MIN = 35
/** 单片耗时上限（秒）。 */
export const CLIP_LATENCY_SECONDS_MAX = 250

/**
 * 片段拼接这一步的固定开销（毫秒）：下载各片段 + ffmpeg 合轨 + 校验时长 + 落盘。
 *
 * 依据 2026-09 现场实测：7 片拼成 30 秒成片约 40 秒，15 片拼成 60 秒约 1 分半；
 * 给足 5 分钟是留出磁盘慢、成片大的余量，不至于让"其实已经拼好了"被判成超时。
 */
export const MEDIA_COMPOSE_OVERHEAD_MS = 5 * 60_000

/** 时长规划结果。 */
export interface DurationPlan {
  /** 目标时长（秒）。 */
  target: number
  /** 每个片段的下单时长（秒），全部落在官方 4~12 内。 */
  clips: number[]
  /** true = 需要多片段合成；false = 一次下单即可（现有 4~12 档位走这条）。 */
  composed: boolean
}

/**
 * 把目标时长规划成片段列表。
 *
 * 规则（每条都能单独验收）：
 * 1. 目标 ≤ 12：单片，按官方区间夹紧——与既有行为完全一致（现有档位不受影响）；
 * 2. 目标 > 12：先用尽量多的 4 秒片段，**余数并入收尾片段**，保证收尾片段也落在 4~12 内；
 *    例如 30 = 4×6 + 6（7 片）、60 = 4×14 + 4（15 片）、13 = 4×2 + 5（3 片）。
 *
 * @param targetSeconds - 目标时长（秒，可为小数）。
 * @returns 规划结果；非有限值按最小档处理。
 */
export function planClipSeconds(targetSeconds: number): DurationPlan {
  const raw = Number.isFinite(targetSeconds) ? Math.round(targetSeconds) : AGNES_VIDEO_SECONDS_MIN
  const target = Math.max(AGNES_VIDEO_SECONDS_MIN, raw)
  if (target <= AGNES_VIDEO_SECONDS_MAX) {
    const single = Math.min(AGNES_VIDEO_SECONDS_MAX, Math.max(AGNES_VIDEO_SECONDS_MIN, target))
    return { target: single, clips: [single], composed: false }
  }
  const clipCount = Math.floor((target - AGNES_VIDEO_SECONDS_MIN) / CLIP_SECONDS)
  const remainder = target - clipCount * CLIP_SECONDS
  const clips = [...Array.from({ length: clipCount }, () => CLIP_SECONDS), remainder]
  return { target, clips, composed: true }
}

/**
 * 规划的片段总时长（应恒等于 target）。
 *
 * @param plan - 规划结果。
 * @returns 各片段之和（秒）。
 */
export function planTotalSeconds(plan: DurationPlan): number {
  return plan.clips.reduce((sum, seconds) => sum + seconds, 0)
}

/**
 * 成片时长与目标不一致时该怎么收敛。
 *
 * 为什么要收敛：厂商返回的成片时长会略有出入（实测要 10 秒拿到 10.14 秒），
 * 而用户是按档位选的：0.5 秒以内算正常误差，超过就按目标裁齐 / 补足，
 * 并在生成记录里如实写明调整了多少——不能让「选了 30 秒」变成「实际 28.4 秒」而无人知晓。
 *
 * @param actualSeconds - 合成后实测的成片时长。
 * @param targetSeconds - 用户选择的目标时长。
 * @returns action 为 trim（裁齐）/ pad（补足）/ none（在容差内）；deltaSeconds 是要调整的秒数（正数）。
 */
export function conformAction(actualSeconds: number, targetSeconds: number): { action: 'none' | 'trim' | 'pad', deltaSeconds: number } {
  if (!Number.isFinite(actualSeconds) || !Number.isFinite(targetSeconds))
    return { action: 'none', deltaSeconds: 0 }
  const delta = actualSeconds - targetSeconds
  if (Math.abs(delta) <= 0.5)
    return { action: 'none', deltaSeconds: 0 }
  return delta > 0
    ? { action: 'trim', deltaSeconds: delta }
    : { action: 'pad', deltaSeconds: -delta }
}

/**
 * 这一次下单的耗时上限（毫秒）：按片段数与单片实测耗时上限推算。
 *
 * 为什么取实测上限而不是均值：预算一旦小于真实耗时，成片已经躺在盘上也会被自己的超时判死
 * （DEF-107：7 片拼出的 30 秒成片在盘上，记录却写"超时"）。宁可多等，不可误杀。
 *
 * @param clips - 片段数（≥1）。
 * @returns 上限毫秒数；片段数非法时按单片段算。
 */
export function clipLatencyCeilingMs(clips: number): number {
  const count = Number.isFinite(clips) ? Math.max(1, Math.round(clips)) : 1
  return count * CLIP_LATENCY_SECONDS_MAX * 1000 + MEDIA_COMPOSE_OVERHEAD_MS
}

/**
 * 视频媒体的耗时预算（毫秒）：按目标时长推导出片段数，再按单片实测上限推算。
 *
 * 单片档位（4~12 秒）同样走这里：一次下单也必须有截止时间，
 * 且它的预算要覆盖厂商偶发的 4 分钟级慢响应。
 *
 * @param targetSeconds - 目标时长（秒）。
 * @param plan - 已算好的时长规划；缺省时按目标时长现算（避免调用方重复规划）。
 * @returns 上限毫秒数。
 */
export function videoMediaLatencyBudgetMs(targetSeconds: number, plan?: DurationPlan): number {
  return clipLatencyCeilingMs((plan ?? planClipSeconds(targetSeconds)).clips.length)
}

/**
 * 该档位给用户的诚实耗时预估（分钟区间，向上取整）。
 *
 * @param targetSeconds - 目标时长。
 * @returns 预估区间与片段数；单片档位按一次下单算。
 */
export function estimateMinutes(targetSeconds: number): { minMinutes: number, maxMinutes: number, clips: number } {
  const plan = planClipSeconds(targetSeconds)
  const count = plan.clips.length
  // 下限受两件事共同约束：单片实测最快 35 秒，以及**免费档每分钟只能真正执行 1 次**
  // （官方 RPM）。此前只按实测延迟算，预估比现实乐观一倍多——用户看着"预计 11 分钟"等了 45 分钟。
  const rpmFloorSeconds = (count * 60) / VIDEO_FREE_TIER_RPM
  const min = Math.max(1, Math.ceil(Math.max(count * CLIP_LATENCY_SECONDS_MIN, rpmFloorSeconds) / 60))
  const max = Math.max(min, Math.ceil((count * CLIP_LATENCY_SECONDS_MAX) / 60))
  return { minMinutes: min, maxMinutes: max, clips: count }
}
