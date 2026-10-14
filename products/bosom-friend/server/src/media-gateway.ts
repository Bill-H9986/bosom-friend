/**
 * 媒体调用的**消费方适配层**：产品侧只保留策略——超时预算、失败分类与可读文案；
 * 图片与视频的厂商 HTTP、端点拼装、请求方言与产物下载全部搬到内核媒体能力面
 * （`packages/media/media` 的 `ctx.media` ＋ `packages/media/media-pi-ai` 的 Provider）。
 *
 * **厂商 HTTP 一处都不剩**（2026-09-23）：产品不再自己出网，全部走 `ctx.media` 的三个操作
 * （出图、视频下单、视频轮询）。长视频里的念白由厂商在出片时自己合成，本机不再有配音链路。
 *
 * 分类一律用能力面的 `isMediaError()`，不要用 `instanceof MediaError`：同一个包在一个进程里可能有两份
 * 物理副本（pnpm 按依赖方的 peer 集合各注入一份），`instanceof` 跨副本为假会让下面四处分类**静默降级**
 * ——429/5xx 不再重试、状态码全丢，一次瞬时厂商错误就能判死整条任务（DEF-169）。
 *
 * 为什么失败要分类而不是直接抛：产品对**暂时**失败（网络、429、5xx）有退避重试与"稍后重试"文案，
 * 对**确定**失败（401/403/4xx）要如实报原因并让用户改配置；能力面把厂商状态码放进 `MediaError`，
 * 分类留在这一层。
 *
 * @module dsh-bosom-friend-server/media-gateway
 */

import { isMediaError } from '@deepseek-ai/dsh-media'

/** 产品侧给媒体调用的超时预算（毫秒）；能力面缺省值更保守，这里按产品的现场实测给足。 */
export const MEDIA_TIMEOUTS = {
  /** 图片生成：厂商实测十几秒到一分钟。 */
  imageMs: 90_000,
  /** 视频下单。 */
  videoCreateMs: 45_000,
  /** 视频状态轮询。 */
  statusPollMs: 20_000,
} as const

/**
 * 这次失败值不值得再试一次。
 *
 * 没应答（网络/超时）与厂商侧的 429/5xx 都是**暂时**的；4xx（参数不合法、密钥/权限）
 * 重试只是白花额度。
 *
 * @param error - 能力面抛出的错误。
 * @returns true 表示可以退避后重试。
 */
export function isRetryableMediaFailure(error: unknown): boolean {
  if (!isMediaError(error)) return false
  if (error.code === 'MEDIA_VENDOR_UNREACHABLE') return true
  if (error.code !== 'MEDIA_VENDOR_REJECTED') return false
  return error.status === 429 || (error.status !== undefined && error.status >= 500)
}

/**
 * 厂商 HTTP 状态码；厂商没应答时没有状态码。
 * @param error - 能力面抛出的错误。
 * @returns 状态码或 undefined。
 */
export function mediaFailureStatus(error: unknown): number | undefined {
  return isMediaError(error) ? error.status : undefined
}

/**
 * 厂商是不是**完全没应答**（网络失败/超时）。
 *
 * 与"厂商明确拒绝"分开：前者是暂时故障、整条任务应当重跑，后者要如实告诉用户改配置。
 *
 * @param error - 能力面抛出的错误。
 * @returns true 表示没有任何响应。
 */
export function isUnreachableMediaFailure(error: unknown): boolean {
  return isMediaError(error) && error.code === 'MEDIA_VENDOR_UNREACHABLE'
}

/** 厂商拒绝的类别：决定「等多久」与「怎么说」。 */
export type VendorFailureKind = 'queue_full' | 'rate_limited' | 'unknown'

/**
 * 把厂商拒绝分成人类能据以行动的三类。
 *
 * 为什么要分：2026-10-11 实测，厂商对同一条任务交替回两种拒绝——
 * `video_queue_full`（他们的视频队列满了，等多久取决于他们）与 `rate_limit_exceeded`
 * （免费档速率限制，等过一个窗口就能过）。混成一句「厂商限流」会让人以为再等等就好，
 * 而队列满可能要几十分钟到几小时 —— 处置完全不同。
 *
 * @param error - 能力面抛出的错误。
 * @returns 队列满 / 速率限制 / 未知。
 */
export function vendorFailureKind(error: unknown): VendorFailureKind {
  if (!isMediaError(error)) return 'unknown'
  const detail = error.detail ?? ''
  if (detail.includes('video_queue_full') || detail.includes('队列已满')) return 'queue_full'
  if (detail.includes('rate_limit_exceeded') || detail.includes('速率限制')) return 'rate_limited'
  if (error.status === 429) return 'rate_limited'
  return 'unknown'
}

/**
 * 把能力面的失败翻成一句人能照着行动的原因（进日志与生成记录）。
 * @param error - 能力面抛出的错误。
 * @param what - 这次调用在做什么（图片 / 视频）。
 * @returns 可读原因。
 */
export function describeMediaFailure(error: unknown, what: 'image' | 'video'): string {
  if (!isMediaError(error)) return '厂商调用出错：' + String(error)
  const status = error.status === undefined ? '' : '（HTTP ' + String(error.status) + '）'
  if (error.code === 'MEDIA_VENDOR_UNREACHABLE') return '厂商无响应（网络失败或超时）'
  // 厂商响应体摘要（`detail`）必须带出来：2026-10-11 排查 429 时发现，只记状态码等于把厂商
  // 唯一能说明「为什么拒」的那句话扔了——配额用尽、并发冲突、风控三种原因的处置完全不同。
  if (error.code === 'MEDIA_VENDOR_REJECTED') {
    const why = error.detail === undefined || error.detail === '' ? '' : '：' + error.detail
    const kind = vendorFailureKind(error)
    if (kind === 'queue_full') return '厂商视频队列已满（HTTP ' + String(error.status) + '，厂商侧容量问题，通常要等几十分钟到几小时）' + why
    if (kind === 'rate_limited') return '厂商限速（HTTP ' + String(error.status) + '，免费档速率限制，等过一个窗口即可）' + why
    return '厂商返回 HTTP ' + String(error.status) + why
  }
  if (error.code === 'MEDIA_VENDOR_NO_RESULT') return '厂商没有返回可用的' + (what === 'image' ? '图片' : '成片')
  if (error.code === 'MEDIA_CREDENTIAL_MISSING') return '媒体凭据未配置：' + error.message
  if (error.code === 'MEDIA_ROUTE_UNKNOWN') return '内核里没有这条媒体路由：' + error.message
  return '媒体能力面报错' + status + '：' + error.message
}
