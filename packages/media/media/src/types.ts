/**
 * Request, result, and error vocabulary of the media capability seam (`ctx.media`).
 *
 * One operation per vendor round trip: generate an image, submit a video job, poll that job.
 * A vendor returns whatever it likes — a URL, base64, a task id, a status document — so every operation
 * normalizes its answer to the types below and reports a non-2xx or missing answer as {@link MediaError}
 * carrying the vendor status. Callers keep their own retry, budget, and scheduling policy; the seam owns
 * only "how do I talk to this vendor".
 *
 * @module @deepseek-ai/dsh-media/types
 */

/** Route id and model of one vendor call. `provider` is the route name configured in the provider implementation. */
export interface MediaCallTarget {
  /** Configured route id inside the selected media provider (for example `agnes`). */
  readonly provider: string
  /** Vendor model id; must be declared by that route. */
  readonly model: string
  /** Per-call vendor timeout in milliseconds; the implementation's own default applies when omitted. */
  readonly timeoutMs?: number
}

/** One decoded media artifact. */
export interface MediaArtifact {
  /** Raw bytes as the vendor delivered them. */
  readonly bytes: Uint8Array
  /** Response content type; empty when the vendor sent none. */
  readonly contentType: string
}

/** Image generation request. */
export interface MediaImageRequest extends MediaCallTarget {
  /** Image prompt. */
  readonly prompt: string
  /** How many images to produce; defaults to one. */
  readonly count?: number
  /**
   * Size tier the caller selected (for example `1K`, `2K`, `720P`), passed through to the vendor dialect.
   * A dialect that cannot express tiers ignores it.
   */
  readonly resolution?: string
  /** Aspect ratio the caller selected (for example `3:4`); ignored by dialects without a ratio field. */
  readonly aspectRatio?: string
  /**
   * Reference images the caller attached, as values the vendor can read (an inlined data URI or a
   * public URL). A dialect that supports image-to-image forwards the first one and the vendor keeps
   * the subject of that image; a dialect without image-to-image ignores them (text-to-image only).
   */
  readonly images?: readonly string[]
  /**
   * Vendor size this route already accepted for this model, remembered by the caller.
   * A dialect that accepts it reuses it instead of trying the tier first.
   */
  readonly preferredSize?: string
}

/** Image generation result. */
export interface MediaImageResult {
  /** Decoded images in vendor order; at least one on success. */
  readonly images: readonly MediaArtifact[]
  /** Model the vendor accepted. */
  readonly model: string
  /** Vendor size the request was finally accepted with, when the dialect reports sizes. */
  readonly acceptedSize?: string
}

/**
 * One reference video a request carries: where to read it, from which second, and whether its
 * soundtrack is required.
 *
 * The vendor reads a reference video for motion, timing, and (when present) sound, then re-renders
 * the requested prompt. `requireAudio` makes a silent source a vendor-side rejection instead of a
 * quietly voice-less render.
 */
export interface MediaReferenceVideo {
  /** Publicly readable video URL, or a data URI when the vendor accepts inline bytes. */
  readonly url: string
  /** Second inside the source where reading starts; the vendor's default applies when omitted. */
  readonly startSeconds?: number
  /** Whether the source must carry an audio track; the vendor's default applies when omitted. */
  readonly requireAudio?: boolean
}

/** Reference material a video request may carry. */
export interface MediaTalkingHead {
  /** Reference images already expressed as values the vendor can read (URL or data URI). */
  readonly images: readonly string[]
  /**
   * Reference audio values, same convention as {@link MediaTalkingHead.images}.
   *
   * Omitted when the render should let the vendor synthesize the speech from the prompt instead of
   * re-voicing a caller-supplied take: passing audio makes the vendor follow that take's timing
   * rather than the written line.
   */
  readonly audios?: readonly string[]
  /**
   * Reference videos, same convention as {@link MediaTalkingHead.images}.
   *
   * A route that offers no video reference reports `MEDIA_OPERATION_UNSUPPORTED`; a route that does
   * re-renders the person and motion of the source instead of only its still frame.
   */
  readonly videos?: readonly MediaReferenceVideo[]
  /** Determinism seed for the talking-head render. */
  readonly seed: number
}

/** Video submission request. */
export interface MediaVideoRequest extends MediaCallTarget {
  /** Video prompt. */
  readonly prompt: string
  /** Requested duration in seconds, clamped by the dialect to the range the vendor accepts. */
  readonly durationSeconds: number
  /** Requested size tier (for example `720p`); the dialect maps it to its own spelling. */
  readonly resolution?: string
  /** Requested aspect ratio (for example `9:16`). */
  readonly aspectRatio?: string
  /** Reference images as vendor-readable values. */
  readonly images?: readonly string[]
  /**
   * Determinism seed for this submission.
   *
   * A caller rendering several shots of one subject passes the same seed across them: without it the
   * vendor samples freely and the subject drifts between shots even with identical reference images.
   */
  readonly seed?: number
  /** Talking-head inputs; a vendor without that mode reports `MEDIA_OPERATION_UNSUPPORTED`. */
  readonly talkingHead?: MediaTalkingHead
  /** Vendor size this route already accepted for this model, remembered by the caller. */
  readonly preferredSize?: string
}

/** Answer to a successful submission: either a finished artifact or a job to poll. */
export interface MediaVideoSubmission {
  /** Model the vendor accepted. */
  readonly model: string
  /** Job id to poll through {@link MediaProvider.pollVideo}. */
  readonly jobId?: string
  /** Finished video returned synchronously by the vendor. */
  readonly video?: MediaArtifact
  /** Vendor size the submission was finally accepted with, when the dialect reports sizes. */
  readonly acceptedSize?: string
}

/** Poll request for one submitted job. */
export interface MediaVideoPollRequest extends MediaCallTarget {
  /** Job id from {@link MediaVideoSubmission.jobId}. */
  readonly jobId: string
}

/** State of one video job. */
export type MediaVideoState = 'pending' | 'completed' | 'failed'

/** Answer to one poll. `completed` carries the artifact; `failed` carries the vendor's reason when it gave one. */
export interface MediaVideoStatus {
  /** Current vendor state. */
  readonly state: MediaVideoState
  /** Finished video, present exactly when `state` is `completed`. */
  readonly video?: MediaArtifact
  /** Vendor-reported failure reason, present when `state` is `failed` and the vendor explained itself. */
  readonly error?: string
}

/** One implementation of the media capability, registered into {@link MediaRuntime}. */
export interface MediaProvider {
  /** Registry key; the service's configured id selects it. */
  readonly id: string
  /** Whether this implementation can serve calls right now (for example: at least one route configured). */
  available(): boolean
  /**
   * Produce images.
   * @param request - prompt, size hints, and vendor target.
   * @param signal - optional cancellation.
   * @returns the decoded images.
   */
  generateImage(request: MediaImageRequest, signal?: AbortSignal): Promise<MediaImageResult>
  /**
   * Submit a video job.
   * @param request - prompt, duration, references, and vendor target.
   * @param signal - optional cancellation.
   * @returns a job to poll or an already finished artifact.
   */
  submitVideo(request: MediaVideoRequest, signal?: AbortSignal): Promise<MediaVideoSubmission>
  /**
   * Poll one submitted job.
   * @param request - the job id and vendor target.
   * @param signal - optional cancellation.
   * @returns the normalized job state.
   */
  pollVideo(request: MediaVideoPollRequest, signal?: AbortSignal): Promise<MediaVideoStatus>
}

/** What one call asked for, in the units that operation takes. */
export interface MediaObservationInput {
  /** Characters of the prompt (image/video). */
  readonly textChars: number
  /** Reference images carried; a talking-head portrait counts here. */
  readonly imageCount: number
  /** Reference audio values carried. */
  readonly audioCount: number
  /** Reference videos carried. */
  readonly videoCount: number
  /** Requested duration in seconds (video only). */
  readonly durationSeconds?: number
  /** Requested size tier (image/video only). */
  readonly resolution?: string
  /** Requested aspect ratio (image/video only). */
  readonly aspectRatio?: string
  /** Requested image count (image only); one when the request named none. */
  readonly count?: number
}

/** What one call produced. */
export interface MediaObservationOutput {
  /** Bytes delivered to the caller: every image, the finished video, or the audio. */
  readonly bytes: number
  /** Content type of the first artifact; empty when the vendor sent none. */
  readonly contentType: string
  /** Artifacts delivered (image only). */
  readonly artifacts?: number
  /** Job id handed back instead of a finished video (video submission only). */
  readonly jobId?: string
}

/**
 * One finished vendor round trip, reported by the seam after it settles.
 *
 * Every operation emits exactly one of these, success or failure, so a consumer can make media work
 * visible in its own traces — input, output, duration, vendor status — without parsing logs or
 * wrapping the seam. The seam reports; consumers decide what to keep.
 */
export interface MediaObservation {
  /** Operation that ran. */
  readonly operation: 'generateImage' | 'submitVideo' | 'pollVideo'
  /** Route the request named; empty when the request named none. */
  readonly provider: string
  /** Vendor model the request named. */
  readonly model: string
  /** Milliseconds the call took, measured by the seam around the provider call. */
  readonly durationMs: number
  /** Whether the call produced a result. */
  readonly ok: boolean
  /** Failure classification; present exactly when `ok` is false and the failure is a {@link MediaError}. */
  readonly errorCode?: MediaErrorCode
  /** Vendor HTTP status; present when the vendor answered. */
  readonly status?: number
  /** What the call asked for. */
  readonly input: MediaObservationInput
  /** What the call produced; present exactly when `ok` is true. */
  readonly output?: MediaObservationOutput
}

/** Machine-readable failure classification. */
export type MediaErrorCode =
  /** The selected implementation cannot serve calls right now. */
  | 'MEDIA_PROVIDER_CONFIGURED_UNAVAILABLE'
  /** The configured implementation id is not registered. */
  | 'MEDIA_PROVIDER_CONFIGURED_MISSING'
  /** No configured id and no usable implementation. */
  | 'MEDIA_PROVIDER_UNAVAILABLE'
  /** No configured id and more than one usable implementation. */
  | 'MEDIA_PROVIDER_AMBIGUOUS'
  /** Two implementations registered under one id. */
  | 'MEDIA_PROVIDER_DUPLICATE'
  /** The requested operation has no vendor mode on this route (for example talking-head on a plain video API). */
  | 'MEDIA_OPERATION_UNSUPPORTED'
  /** The selected implementation declares no such route. */
  | 'MEDIA_ROUTE_UNKNOWN'
  /** The route names a credential ref that resolves to nothing. */
  | 'MEDIA_CREDENTIAL_MISSING'
  /** The vendor answered with a non-2xx status. */
  | 'MEDIA_VENDOR_REJECTED'
  /** Nothing came back: connection failure, DNS failure, or timeout. */
  | 'MEDIA_VENDOR_UNREACHABLE'
  /** The vendor answered 2xx without a usable result. */
  | 'MEDIA_VENDOR_NO_RESULT'

/**
 * Marker every {@link MediaError} carries, shared across physical copies of this package.
 *
 * Why not `instanceof`: one process can hold two copies of this package — pnpm injects one copy per
 * dependent's peer set — and an error raised by the copy inside the provider is not an instance of the
 * class the caller imported. The product's failure classification then saw "unknown error" for every
 * vendor failure: no retry on 429/5xx, no status code, and a whole long-video task died on one
 * transient vendor 503 (qa/defects/DEF-169). `Symbol.for` resolves to the same symbol in every copy.
 */
const MEDIA_ERROR_TAG = Symbol.for('@deepseek-ai/dsh-media/MediaError')

/**
 * Whether a value is a {@link MediaError}, including one raised by another copy of this package.
 *
 * Consumers classify vendor failures with this guard instead of `instanceof MediaError`; see
 * {@link MEDIA_ERROR_TAG} for the duplication that makes `instanceof` unreliable here.
 *
 * @param value - the value to test.
 * @returns true when the value carries the media-error marker.
 */
export function isMediaError(value: unknown): value is MediaError {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[MEDIA_ERROR_TAG] === true
}

/** Failure raised by the seam or by an implementation. */
export class MediaError extends Error {
  /** Cross-copy identity marker; test with {@link isMediaError}. */
  readonly [MEDIA_ERROR_TAG] = true
  /** Machine-readable classification. */
  readonly code: MediaErrorCode
  /** Vendor HTTP status when the vendor answered; absent when nothing came back. */
  readonly status?: number
  /** Vendor body excerpt for diagnostics; never carries credentials. */
  readonly detail?: string

  /**
   * @param message - human-readable reason.
   * @param code - machine-readable classification.
   * @param options - vendor status and body excerpt when the vendor answered.
   */
  constructor(message: string, code: MediaErrorCode, options: { status?: number; detail?: string } = {}) {
    super(message)
    this.name = 'MediaError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
    if (options.detail !== undefined) this.detail = options.detail
  }
}
