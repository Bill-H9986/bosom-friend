/**
 * Media provider for OpenAI-compatible vendors (`dsh-media-pi-ai`): the only place where media vendor
 * HTTP appears. It registers one implementation into `ctx.media` and answers the seam's three operations
 * by picking a configured route, resolving that route's credential, and translating the call into the
 * route's wire dialect (see `./vendor.ts`).
 *
 * Routes and credentials come from the `media-pi-ai` user-settings section, so an endpoint or key change
 * reaches the next call without a restart. A route with no `apiKeyEnv` is called without an authorization
 * header, which is what a same-host OpenAI-compatible server needs.
 *
 * @module @deepseek-ai/dsh-media-pi-ai
 */

import type { Context } from '@deepseek-ai/cordis'
import { MediaError } from '@deepseek-ai/dsh-media'
import type {
  MediaArtifact,
  MediaImageRequest,
  MediaImageResult,
  MediaProvider,
  MediaVideoPollRequest,
  MediaVideoRequest,
  MediaVideoStatus,
  MediaVideoSubmission,
} from '@deepseek-ai/dsh-media'
import type {} from '@deepseek-ai/dsh-settings'
import { Config, routeOf } from './config.ts'
import type { PiAiMediaRoute } from './config.ts'
import {
  bestSizeFor,
  excerpt,
  firstVideoSize,
  imageBody,
  imageEndpoint,
  imageSizeOf,
  pickImageCandidate,
  pickTaskId,
  pickVideoId,
  pickVideoUrl,
  validSizesOf,
  videoBody,
  videoCreateEndpoint,
  videoStatusEndpoint,
} from './vendor.ts'

export { Config } from './config.ts'
export type { MediaApi, PiAiMediaRoute } from './config.ts'

export const name = 'media-pi-ai'
/** The provider registers into the media seam. */
export const inject = ['media']

/** Per-call timeouts used when the caller does not state one. */
export const MEDIA_TIMEOUTS = {
  /** Image generation: vendors take tens of seconds. */
  imageMs: 90_000,
  /** Video submission. */
  videoCreateMs: 45_000,
  /** One video status poll. */
  statusPollMs: 20_000,
  /** Artifact download (an image or a finished video). */
  downloadMs: 120_000,
} as const

/** One vendor answer, with the body parsed when it was JSON. */
interface JsonAnswer {
  /** HTTP status. */
  readonly status: number
  /** Whether the status was 2xx. */
  readonly ok: boolean
  /** Parsed body; `undefined` when the body was empty or not JSON. */
  readonly payload: unknown
  /** Raw body excerpt for diagnostics. */
  readonly detail: string
}

/** Inputs the provider needs from its host: the current routes and a credential resolver. */
export interface PiAiMediaProviderOptions {
  /** Current route configuration, read per call so a settings change reaches the next request. */
  readonly config: () => Config
  /** Resolve one credential ref to its value; `undefined` when nothing is stored under it. */
  readonly resolveCredential: (ref: string) => Promise<string | undefined>
}

/**
 * Build the provider for one configuration source.
 *
 * The plugin's `apply` supplies the live route set and the credentials seam; a composition that
 * already knows both (a test harness, an embedded host) can build the same provider directly and
 * register it into any media service.
 *
 * @param options - route source and credential resolver.
 * @returns the media provider implementation.
 */
export function createPiAiMediaProvider(options: PiAiMediaProviderOptions): MediaProvider {
  const current = options.config

  /**
   * Resolve one route's credential. A route that names no ref is called anonymously; a route that
   * names one and cannot resolve it fails loud rather than calling the vendor unauthenticated.
   * @param routeId - route id for the diagnostic.
   * @param route - the route.
   * @returns the key, or an empty string for an anonymous route.
   */
  const resolveKey = async (routeId: string, route: PiAiMediaRoute): Promise<string> => {
    const ref = route.apiKeyEnv
    if (ref === undefined || ref === '') return ''
    const hit = await options.resolveCredential(ref)
    if (hit !== undefined && hit !== '') return hit
    throw new MediaError(
      `media-pi-ai: no credential for route "${routeId}"; it names ${ref}, which is not set — store ${ref}`
      + ' through the credentials service or export it, and drop apiKeyEnv only for an unauthenticated route',
      'MEDIA_CREDENTIAL_MISSING',
    )
  }

  /** Look the route up or fail with the route id the caller used. */
  const requireRoute = (routeId: string): PiAiMediaRoute => {
    const route = routeOf(current(), routeId)
    if (route === undefined) {
      throw new MediaError(
        `media-pi-ai: no route "${routeId}" is configured; declare it under the media-pi-ai providers section`,
        'MEDIA_ROUTE_UNKNOWN',
      )
    }
    return route
  }

  /** Send one request; a transport failure becomes `MEDIA_VENDOR_UNREACHABLE`, never a bare fetch error. */
  const send = async (
    request: { readonly endpoint: string; readonly method: 'GET' | 'POST'; readonly body?: Record<string, unknown> },
    apiKey: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      return await fetch(request.endpoint, {
        method: request.method,
        headers: {
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(apiKey === '' ? {} : { authorization: 'Bearer ' + apiKey }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    }
    catch (error) {
      throw new MediaError(
        `media-pi-ai: ${request.method} ${request.endpoint} got no answer (${String(error)})`,
        'MEDIA_VENDOR_UNREACHABLE',
      )
    }
  }

  /** Send one JSON request and normalize the answer. */
  const sendJson = async (
    request: { readonly endpoint: string; readonly method: 'GET' | 'POST'; readonly body?: Record<string, unknown> },
    apiKey: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonAnswer> => {
    const response = await send(request, apiKey, timeoutMs, signal)
    const text = await response.text()
    let payload: unknown
    try {
      payload = text.trim() === '' ? undefined : JSON.parse(text)
    }
    catch {
      // A non-JSON body (gateway HTML, empty body) still carries its status and excerpt, which is
      // all a caller needs to classify the failure.
      payload = undefined
    }
    return { status: response.status, ok: response.ok, payload, detail: excerpt(text) }
  }

  /** Turn a non-2xx answer into the rejection failure carrying the vendor status. */
  const rejected = (what: string, answer: JsonAnswer): MediaError => new MediaError(
    `media-pi-ai: ${what} was rejected with HTTP ${answer.status}`,
    'MEDIA_VENDOR_REJECTED',
    { status: answer.status, ...answer.detail === '' ? {} : { detail: answer.detail } },
  )

  /** Download a vendor artifact; a failed download is `MEDIA_VENDOR_NO_RESULT`, not a transport error. */
  const download = async (url: string, timeoutMs: number, signal?: AbortSignal): Promise<MediaArtifact> => {
    const response = await send({ endpoint: url, method: 'GET' }, '', timeoutMs, signal)
    if (!response.ok) {
      throw new MediaError(`media-pi-ai: artifact download answered HTTP ${response.status}`, 'MEDIA_VENDOR_NO_RESULT', { status: response.status })
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length === 0) throw new MediaError('media-pi-ai: artifact download returned an empty body', 'MEDIA_VENDOR_NO_RESULT')
    return { bytes, contentType: response.headers.get('content-type') ?? '' }
  }

  const provider: MediaProvider = {
    id: 'pi-ai',
    available: () => Object.keys(current().providers).length > 0,

    async generateImage(request: MediaImageRequest, signal?: AbortSignal): Promise<MediaImageResult> {
      const route = requireRoute(request.provider)
      const apiKey = await resolveKey(request.provider, route)
      const endpoint = imageEndpoint(route)
      const timeoutMs = request.timeoutMs ?? MEDIA_TIMEOUTS.imageMs
      const count = Math.max(1, Math.min(Math.trunc(request.count ?? 1), 8))
      const images: MediaArtifact[] = []
      let acceptedSize = imageSizeOf(route, request)
      for (let index = 0; index < count; index++) {
        const body = imageBody(route, request)
        let answer = await sendJson({ endpoint, method: 'POST', body }, apiKey, timeoutMs, signal)
        if (!answer.ok && answer.status === 400 && route.api !== 'agnes' && acceptedSize !== '1024x1024') {
          // The OpenAI dialect only rejects a request for its size field: retry once with the
          // universally accepted square before reporting the vendor's rejection.
          acceptedSize = '1024x1024'
          answer = await sendJson({ endpoint, method: 'POST', body: imageBody(route, { ...request, preferredSize: acceptedSize }) }, apiKey, timeoutMs, signal)
        }
        if (!answer.ok) {
          // First image failing is this call's failure; a later one keeps what already decoded.
          if (index === 0) throw rejected('image generation', answer)
          break
        }
        const candidate = pickImageCandidate(answer.payload)
        // A 2xx document without an image, or one whose URL cannot be delivered, costs this image
        // only: the caller still receives whatever the vendor did deliver.
        if (candidate === undefined) continue
        let artifact: MediaArtifact | undefined
        if (candidate.kind === 'base64') {
          const bytes = new Uint8Array(Buffer.from(candidate.data, 'base64'))
          artifact = bytes.length === 0 ? undefined : { bytes, contentType: 'image/png' }
        }
        else {
          try {
            artifact = await download(candidate.url, MEDIA_TIMEOUTS.downloadMs, signal)
          }
          catch {
            // One undeliverable image is skipped; the caller still gets the images that arrived.
            artifact = undefined
          }
        }
        if (artifact === undefined) continue
        images.push(artifact)
      }
      if (images.length === 0) throw new MediaError('media-pi-ai: image generation produced no image', 'MEDIA_VENDOR_NO_RESULT')
      return { images, model: request.model, acceptedSize }
    },

    async submitVideo(request: MediaVideoRequest, signal?: AbortSignal): Promise<MediaVideoSubmission> {
      const route = requireRoute(request.provider)
      if (route.api !== 'agnes' && request.talkingHead !== undefined) {
        // The OpenAI-compatible video API carries image references but no audio input, so a
        // talking-head request has no wire representation there; saying so beats a wasted round trip.
        throw new MediaError(
          `media-pi-ai: route "${request.provider}" has no talking-head mode; it speaks the OpenAI-compatible video API, which takes no audio input`,
          'MEDIA_OPERATION_UNSUPPORTED',
        )
      }
      const apiKey = await resolveKey(request.provider, route)
      const endpoint = videoCreateEndpoint(route)
      const timeoutMs = request.timeoutMs ?? MEDIA_TIMEOUTS.videoCreateMs
      let size = firstVideoSize(route, request)
      let answer = await sendJson({ endpoint, method: 'POST', body: videoBody(route, request, size) }, apiKey, timeoutMs, signal)
      if (!answer.ok && answer.status === 400 && route.api === 'agnes') {
        // Agnes reports the sizes it accepts in the rejection body; one retry at the closest
        // reported size keeps the job alive instead of failing the caller's whole task.
        const fallback = bestSizeFor(size, validSizesOf(answer.payload))
        if (fallback !== '' && fallback !== size) {
          size = fallback
          answer = await sendJson({ endpoint, method: 'POST', body: videoBody(route, request, size) }, apiKey, timeoutMs, signal)
        }
      }
      if (!answer.ok) throw rejected('video submission', answer)
      const url = pickVideoUrl(answer.payload)
      if (url !== '') return { model: request.model, video: await download(url, MEDIA_TIMEOUTS.downloadMs, signal), acceptedSize: size }
      const jobId = route.api === 'agnes' ? pickVideoId(answer.payload) : pickTaskId(answer.payload)
      if (jobId === '') throw new MediaError('media-pi-ai: video submission returned no job id', 'MEDIA_VENDOR_NO_RESULT')
      return { model: request.model, jobId, acceptedSize: size }
    },

    async pollVideo(request: MediaVideoPollRequest, signal?: AbortSignal): Promise<MediaVideoStatus> {
      const route = requireRoute(request.provider)
      const apiKey = await resolveKey(request.provider, route)
      const answer = await sendJson(
        { endpoint: videoStatusEndpoint(route, request.jobId, request.model), method: 'GET' },
        apiKey,
        request.timeoutMs ?? MEDIA_TIMEOUTS.statusPollMs,
        signal,
      )
      if (!answer.ok) throw rejected('video status', answer)
      const payload = typeof answer.payload === 'object' && answer.payload !== null ? answer.payload as Record<string, unknown> : {}
      const state = typeof payload.status === 'string' ? payload.status : ''
      if (state === 'failed') {
        const reason = typeof payload.error === 'string' ? payload.error : ''
        return { state: 'failed', ...reason === '' ? {} : { error: reason } }
      }
      const url = pickVideoUrl(answer.payload)
      if (url !== '') return { state: 'completed', video: await download(url, MEDIA_TIMEOUTS.downloadMs, signal) }
      if (state === 'completed') throw new MediaError('media-pi-ai: video reported completed without an artifact', 'MEDIA_VENDOR_NO_RESULT')
      return { state: 'pending' }
    },

  }

  return provider
}

/**
 * Register the media provider. A route set arrives from the plugin config and is replaced by the
 * `media-pi-ai` settings section when the settings seam is present.
 * @param ctx - owning context.
 * @param config - initial route configuration.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  ctx.media.registerProvider(createPiAiMediaProvider({
    config: () => current(),
    resolveCredential: async (ref: string) => {
      const credentials = ctx.get('credentials')
      // Without the seam the environment is the whole credential plane.
      return credentials !== undefined ? (await credentials.resolve(ref))?.value : process.env[ref]
    },
  }))
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, 'media-pi-ai', Config, config, {
      // The source is a live getter, so every call already reads the current section; the change
      // notification has nothing extra to rebuild because routes carry no registration-captured state.
      setSource: (source: () => Config) => { current = source },
      onChange: () => undefined,
    })
  })
}
