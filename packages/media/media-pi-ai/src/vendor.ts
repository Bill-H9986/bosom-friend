/**
 * Vendor dialect rules of the pi-ai media routes: endpoint layout, request field names, and the
 * normalization of whatever document the vendor answers with. Pure functions and constants only —
 * no HTTP, no configuration lookup — so every rule here is unit-testable on its own.
 *
 * Two dialects are supported. `openai` speaks the OpenAI-compatible field names (`size`, `resolution`,
 * `aspect_ratio`) and the `/videos/generations` + `/videos/<id>` pair. `agnes` speaks the Agnes AI
 * contract: tier + ratio on images, `seconds` as a string in `4`..`12` on video, a `mode`-selected
 * reference block, and the `/agnesapi` status document on the origin.
 *
 * @module @deepseek-ai/dsh-media-pi-ai/vendor
 */

import type { MediaImageRequest, MediaReferenceVideo, MediaTalkingHead, MediaVideoRequest } from '@deepseek-ai/dsh-media'
import type { PiAiMediaRoute } from './config.ts'

/** Agnes image size tiers; the vendor standardizes anything else. */
const AGNES_IMAGE_TIERS = ['1K', '2K', '3K', '4K'] as const
/** Agnes image ratios; the vendor rejects values outside this list. */
const AGNES_IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'] as const
/** Agnes video sizes. */
const AGNES_VIDEO_SIZES = ['720P', '1080P', '1K', '2K'] as const
/** Agnes video sizes in ascending height: the index in this list is the size's rank. */
const AGNES_VIDEO_SIZE_ORDER = ['720P', '1K', '1080P', '2K'] as const
/** One Agnes video size. */
type AgnesVideoSize = typeof AGNES_VIDEO_SIZE_ORDER[number]
/** Agnes video ratios. */
const AGNES_VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const
/** Agnes video duration bounds; `seconds` is a string and outside this range the vendor rejects the call. */
const AGNES_VIDEO_SECONDS_MIN = 4
const AGNES_VIDEO_SECONDS_MAX = 12
/** Per-model Agnes video size support; an unlisted model keeps only the conservative tier. */
const AGNES_VIDEO_MODEL_SIZES: Record<string, readonly string[]> = {
  'agnes-video-2.5': AGNES_VIDEO_SIZES,
  'agnes-video-2.5-flash': ['720P'],
}
/** Reference-material limits: images, audios, and videos a reference request may carry. */
const AGNES_REFERENCE_LIMITS = { images: 5, audios: 3, videos: 1 } as const
/** Fallback pixel size for the OpenAI dialect when the caller supplied no usable one. */
const OPENAI_DEFAULT_IMAGE_SIZE = '1024x1024'
/** Longest vendor body excerpt kept in a rejection diagnostic. */
const DETAIL_LIMIT = 200

/** Base URL without trailing slashes. */
function trimBase(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

/**
 * Versioned endpoint: a base URL that already ends in a version keeps it, anything else gains `/v1`.
 * @param baseURL - route base URL.
 * @param path - path beginning with `/`.
 * @returns the absolute endpoint.
 */
export function versionedPath(baseURL: string, path: string): string {
  const base = trimBase(baseURL)
  return /\/v\d+$/.test(base) ? base + path : base + '/v1' + path
}

/**
 * Origin of a route's base URL, used by endpoints that live outside the version prefix.
 * @param baseURL - route base URL.
 * @returns scheme and host.
 */
export function originOf(baseURL: string): string {
  return new URL(trimBase(baseURL)).origin
}

/**
 * Image generation endpoint.
 * @param route - the route.
 * @returns the absolute endpoint.
 */
export function imageEndpoint(route: PiAiMediaRoute): string {
  return versionedPath(route.baseURL, '/images/generations')
}

/**
 * Video submission endpoint: Agnes submits on `/videos`, the OpenAI dialect on `/videos/generations`.
 * @param route - the route.
 * @returns the absolute endpoint.
 */
export function videoCreateEndpoint(route: PiAiMediaRoute): string {
  return route.api === 'agnes'
    ? versionedPath(route.baseURL, '/videos')
    : versionedPath(route.baseURL, '/videos/generations')
}

/**
 * Video status endpoint: Agnes reads `/agnesapi` on the origin, the OpenAI dialect `/videos/<id>`.
 * @param route - the route.
 * @param jobId - job id from the submission.
 * @param model - model the job was submitted with (Agnes interprets status by model).
 * @returns the absolute endpoint.
 */
export function videoStatusEndpoint(route: PiAiMediaRoute, jobId: string, model: string): string {
  if (route.api === 'agnes') {
    return originOf(route.baseURL) + '/agnesapi?video_id=' + encodeURIComponent(jobId) + '&model_name=' + encodeURIComponent(model)
  }
  return versionedPath(route.baseURL, '/videos/' + encodeURIComponent(jobId))
}

/**
 * Map a caller tier onto an Agnes image size.
 * @param tier - caller tier (for example `720p`); unknown values take the higher tier.
 * @returns the Agnes `size` value.
 */
export function agnesImageTier(tier: string | undefined): string {
  return (tier ?? '').trim().toLowerCase() === '720p' ? '1K' : '2K'
}

/**
 * Map a caller ratio onto an Agnes image ratio.
 * @param ratio - caller ratio (for example `9:16`).
 * @returns the Agnes `ratio` value; `1:1` when the caller supplied something the vendor does not accept.
 */
export function agnesImageRatio(ratio: string | undefined): string {
  const value = (ratio ?? '').trim()
  return (AGNES_IMAGE_RATIOS as readonly string[]).includes(value) ? value : '1:1'
}

/**
 * Map a caller ratio onto an Agnes video ratio.
 * @param ratio - caller ratio.
 * @returns the Agnes `aspect_ratio` value; `9:16` (the product's default shape) when unknown.
 */
export function agnesVideoRatio(ratio: string | undefined): string {
  const value = (ratio ?? '').trim()
  return (AGNES_VIDEO_RATIOS as readonly string[]).includes(value) ? value : '9:16'
}

/**
 * Map a caller tier onto the size an Agnes model accepts.
 * @param model - video model id.
 * @param tier - caller tier (for example `1080p`).
 * @returns the highest supported size not exceeding the requested one.
 */
export function agnesVideoSize(model: string, tier: string | undefined): string {
  const requested = (tier ?? '').trim().toUpperCase()
  const supported = AGNES_VIDEO_MODEL_SIZES[model] ?? ['720P']
  if (supported.includes(requested)) return requested
  // An unknown tier ranks below every supported size, so the model's lowest size answers it.
  const requestedRank = AGNES_VIDEO_SIZE_ORDER.indexOf(requested as AgnesVideoSize)
  const withinRequest = supported.filter(label => AGNES_VIDEO_SIZE_ORDER.indexOf(label as AgnesVideoSize) <= requestedRank)
  const pool = withinRequest.length > 0 ? withinRequest : supported
  let best = ''
  for (const label of pool) {
    if (best === '' || AGNES_VIDEO_SIZE_ORDER.indexOf(label as AgnesVideoSize) > AGNES_VIDEO_SIZE_ORDER.indexOf(best as AgnesVideoSize)) best = label
  }
  return best
}

/**
 * Clamp a duration into the Agnes `seconds` range and render it as the string the vendor expects.
 * @param seconds - requested duration.
 * @returns the `seconds` value.
 */
export function agnesVideoSeconds(seconds: number): string {
  const rounded = Number.isFinite(seconds) ? Math.round(seconds) : AGNES_VIDEO_SECONDS_MIN
  return String(Math.min(AGNES_VIDEO_SECONDS_MAX, Math.max(AGNES_VIDEO_SECONDS_MIN, rounded)))
}

/**
 * Agnes reference mode for plain image references: none is text, one is a keyframe, two add a last
 * frame, more become content/style references.
 * @param images - reference images as vendor-readable values.
 * @returns the mode fields merged into the submission body.
 */
export function agnesModeFields(images: readonly string[]): Record<string, unknown> {
  if (images.length === 0) return { mode: 'text' }
  if (images.length === 1) return { mode: 'keyframe', first_frame: images[0] }
  if (images.length === 2) return { mode: 'keyframe', first_frame: images[0], last_frame: images[1] }
  return { mode: 'reference', images: images.slice(0, AGNES_REFERENCE_LIMITS.images) }
}

/**
 * One reference video in the vendor's object form.
 *
 * `require_audio` is only sent when the caller named it: an absent key means the vendor's default
 * (the source may or may not carry a soundtrack), which is a different request from `false`.
 *
 * @param video - reference video as the caller described it.
 * @returns the vendor's reference-video object.
 */
export function agnesReferenceVideo(video: MediaReferenceVideo): Record<string, unknown> {
  return {
    url: video.url,
    ...(video.startSeconds === undefined ? {} : { start_seconds: video.startSeconds }),
    ...(video.requireAudio === undefined ? {} : { require_audio: video.requireAudio }),
  }
}

/**
 * Agnes talking-head mode: a reference request carrying the portrait, the speech audio, and/or a
 * reference video of the same person.
 *
 * @param talkingHead - reference images, audios, videos, and seed.
 * @returns the mode fields merged into the submission body.
 */
export function agnesTalkingHeadFields(talkingHead: MediaTalkingHead): Record<string, unknown> {
  const audios = talkingHead.audios ?? []
  const videos = talkingHead.videos ?? []
  return {
    mode: 'reference',
    images: talkingHead.images.slice(0, AGNES_REFERENCE_LIMITS.images),
    // Omitting a key entirely lets the vendor decide from what is present; an empty array is a
    // different request the vendor rejects.
    ...(audios.length === 0 ? {} : { audios: audios.slice(0, AGNES_REFERENCE_LIMITS.audios) }),
    ...(videos.length === 0 ? {} : { videos: videos.slice(0, AGNES_REFERENCE_LIMITS.videos).map(agnesReferenceVideo) }),
    seed: talkingHead.seed,
  }
}

/** One image the vendor described: base64 already in the document, or a URL to fetch. */
export type ImageCandidate =
  | { readonly kind: 'base64'; readonly data: string }
  | { readonly kind: 'url'; readonly url: string }

/**
 * First image candidate in a vendor document, preferring base64 (no second request).
 * @param payload - parsed vendor response.
 * @returns the candidate, or `undefined` when the document carries no image.
 */
export function pickImageCandidate(payload: unknown): ImageCandidate | undefined {
  const record = asRecord(payload)
  const list = Array.isArray(record?.data) ? record.data : Array.isArray(record?.images) ? record.images : []
  const item = asRecord(list[0])
  if (item === undefined) return undefined
  if (typeof item.b64_json === 'string' && item.b64_json !== '') return { kind: 'base64', data: item.b64_json }
  if (typeof item.url === 'string' && item.url !== '') return { kind: 'url', url: item.url }
  return undefined
}

/**
 * Finished-video URL in a vendor document, across the field names the supported vendors use.
 * @param payload - parsed vendor response.
 * @returns the URL, or an empty string when the document carries none.
 */
export function pickVideoUrl(payload: unknown): string {
  const record = asRecord(payload)
  if (record === undefined) return ''
  const data = record.data
  if (Array.isArray(data)) {
    for (const item of data) {
      const entry = asRecord(item)
      const url = typeof entry?.url === 'string' ? entry.url : typeof entry?.video_url === 'string' ? entry.video_url : ''
      if (url !== '') return url
    }
  }
  else {
    const entry = asRecord(data)
    const url = typeof entry?.url === 'string' ? entry.url : typeof entry?.video_url === 'string' ? entry.video_url : ''
    if (url !== '') return url
  }
  const output = record.output
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string' && /^https?:/i.test(item)) return item
      const url = asRecord(item)?.url
      if (typeof url === 'string' && url !== '') return url
    }
  }
  if (typeof record.url === 'string' && record.url !== '') return record.url
  const metadataUrl = asRecord(record.metadata)?.url
  return typeof metadataUrl === 'string' ? metadataUrl : ''
}

/**
 * Job id in a vendor document.
 * @param payload - parsed vendor response.
 * @returns the id, or an empty string when the document carries none.
 */
export function pickTaskId(payload: unknown): string {
  const record = asRecord(payload)
  if (record === undefined) return ''
  const data = record.data
  const candidate = Array.isArray(data) ? asRecord(data[0])?.id : asRecord(data)?.id
  if (typeof candidate === 'string' && candidate !== '') return candidate
  return ''
}

/**
 * Video job id of an Agnes submission, which names the field `video_id`.
 * @param payload - parsed vendor response.
 * @returns the id, or an empty string when the document carries none.
 */
export function pickVideoId(payload: unknown): string {
  const record = asRecord(payload)
  const videoId = record?.video_id
  if (typeof videoId === 'string' && videoId !== '') return videoId
  return pickTaskId(payload)
}

/**
 * Sizes a vendor reported as valid in a rejection body.
 * @param payload - parsed vendor response.
 * @returns the reported sizes; empty when the document carries none.
 */
export function validSizesOf(payload: unknown): string[] {
  const sizes = asRecord(asRecord(payload)?.data)?.valid_sizes
  return Array.isArray(sizes) ? sizes.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Closest size to a requested one among a vendor-reported list, compared by pixel height.
 * @param target - requested size (for example `1080P`).
 * @param valid - vendor-reported sizes.
 * @returns the closest valid size, or an empty string when none is usable.
 */
export function bestSizeFor(target: string, valid: readonly string[]): string {
  const heightOf = (label: string): number => {
    const normalized = label.trim().toUpperCase()
    const named: Record<string, number> = { '720P': 720, '960P': 960, '1080P': 1080, '2K': 1440, '4K': 2160 }
    if (named[normalized] !== undefined) return named[normalized]
    const pixels = /^(\d+)X(\d+)$/.exec(normalized)
    return pixels === null ? 0 : Number(pixels[2])
  }
  const targetHeight = heightOf(target)
  // Tallest reported size at or below the request; when the vendor offers nothing that small,
  // the cheapest one above it, so the call can still produce a result.
  let below = ''
  let above = ''
  for (const label of valid) {
    const height = heightOf(label)
    if (height === 0) continue
    if (height <= targetHeight) {
      if (below === '' || height > heightOf(below)) below = label
    }
    else if (above === '' || height < heightOf(above)) above = label
  }
  return below !== '' ? below : above
}

/**
 * Request body of one image generation call.
 * @param route - the route (its dialect selects the field names).
 * @param request - the call.
 * @returns the body to send.
 */
export function imageSizeOf(route: PiAiMediaRoute, request: MediaImageRequest): string {
  const preferred = (request.preferredSize ?? '').trim()
  if (preferred !== '') return route.api === 'agnes' ? preferred.toUpperCase() : preferred
  const resolution = (request.resolution ?? '').trim()
  if (route.api === 'agnes') {
    const upper = resolution.toUpperCase()
    return (AGNES_IMAGE_TIERS as readonly string[]).includes(upper) ? upper : agnesImageTier(resolution)
  }
  return /^\d+x\d+$/i.test(resolution) ? resolution : OPENAI_DEFAULT_IMAGE_SIZE
}

/**
 * Request body of one image generation call.
 * @param route - the route (its dialect selects the field names).
 * @param request - the call.
 * @returns the body to send; the size it carries is {@link imageSizeOf}.
 */
export function imageBody(route: PiAiMediaRoute, request: MediaImageRequest): Record<string, unknown> {
  const size = imageSizeOf(route, request)
  // 参考图走厂商的 image-to-image 队列：Agnes 的**字段名是单数 `image`**，但它的值是**数组**——
  // 官方文档写明"输入图像数组…多图合成时传入多张图像"（复数 `images` 才是错的，那是视频侧的名字）。
  // 实测：`image: [图1, 图2]` → HTTP 200，产物落在 `/images/i2i/…`，人物身份与设备外形都保住；
  // 只传第一张时第二张完全不起作用（此前产品就是这么传的，多图合成能力等于没接）。
  const references = (request.images ?? []).filter(value => typeof value === 'string' && value !== '')
  if (route.api === 'agnes') {
    return {
      model: request.model,
      prompt: request.prompt,
      n: 1,
      size,
      ratio: agnesImageRatio(request.aspectRatio),
      ...(references.length === 0 ? {} : { image: references }),
      extra_body: { response_format: 'url' },
    }
  }
  return { model: request.model, prompt: request.prompt, n: 1, size, ...(references.length === 0 ? {} : { image: references }) }
}

/**
 * Request body of one video submission.
 * @param route - the route (its dialect selects the field names and mode block).
 * @param request - the call.
 * @param size - the vendor size this attempt uses, already mapped to the dialect's spelling.
 * @returns the body to send.
 */
export function videoBody(route: PiAiMediaRoute, request: MediaVideoRequest, size: string): Record<string, unknown> {
  const images = request.talkingHead === undefined ? (request.images ?? []) : request.talkingHead.images
  if (route.api === 'agnes') {
    return {
      model: request.model,
      prompt: request.prompt,
      seconds: agnesVideoSeconds(request.durationSeconds),
      size,
      aspect_ratio: agnesVideoRatio(request.aspectRatio),
      ...(request.talkingHead === undefined ? agnesModeFields(images) : agnesTalkingHeadFields(request.talkingHead)),
      // 跨镜一致性靠固定 seed：不给时厂商每次自由采样，同一套参考图也会逐镜漂移。
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    }
  }
  return {
    model: request.model,
    prompt: request.prompt,
    duration: Math.max(1, Math.round(request.durationSeconds)),
    resolution: size,
    aspect_ratio: (request.aspectRatio ?? '').trim() === '' ? '9:16' : request.aspectRatio,
    ...(images.length > 0 ? { image: images[0], images } : {}),
  }
}

/**
 * Size one video submission attempt starts with.
 * @param route - the route.
 * @param request - the call.
 * @returns the vendor size (Agnes spellings) or resolution string (OpenAI dialect).
 */
export function firstVideoSize(route: PiAiMediaRoute, request: MediaVideoRequest): string {
  if (request.preferredSize !== undefined && request.preferredSize !== '') return request.preferredSize
  return route.api === 'agnes' ? agnesVideoSize(request.model, request.resolution) : (request.resolution ?? '720p')
}

/**
 * Short, credential-free excerpt of a vendor body for a diagnostic.
 * @param text - raw vendor body.
 * @returns the excerpt, collapsed to one line.
 */
export function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, DETAIL_LIMIT)
}

/** Narrow an unknown value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
