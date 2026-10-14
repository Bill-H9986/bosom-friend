/**
 * Service Definition for the media capability seam (`ctx.media`): the provider registry and the three
 * vendor round trips — image generation, video submission, video polling — that application code calls
 * instead of talking to a vendor endpoint itself.
 *
 * Selection happens per call and never depends on registration order: a configured provider id must be
 * registered and usable, and without one exactly one usable provider is required. Vendor dialect,
 * credentials, and HTTP live in a Service Provider (`dsh-media-pi-ai`); this package owns only the
 * vocabulary and the selection policy.
 *
 * Every call also reports one {@link MediaObservation} on `media/observation` — input, output, duration,
 * failure classification — so the consumer that must show "what did this cost and produce" does not have
 * to wrap the seam or parse logs.
 *
 * @module @deepseek-ai/dsh-media
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MediaError, isMediaError } from './types.ts'
import type {
  MediaCallTarget,
  MediaImageRequest,
  MediaImageResult,
  MediaObservation,
  MediaObservationInput,
  MediaObservationOutput,
  MediaProvider,
  MediaVideoPollRequest,
  MediaVideoRequest,
  MediaVideoStatus,
  MediaVideoSubmission,
} from './types.ts'

export { MediaError, isMediaError } from './types.ts'
export type {
  MediaArtifact,
  MediaCallTarget,
  MediaErrorCode,
  MediaObservation,
  MediaObservationInput,
  MediaObservationOutput,
  MediaImageRequest,
  MediaImageResult,
  MediaProvider,
  MediaReferenceVideo,
  MediaTalkingHead,
  MediaVideoPollRequest,
  MediaVideoRequest,
  MediaVideoState,
  MediaVideoStatus,
  MediaVideoSubmission,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    media: MediaRuntime
  }
  interface Events {
    /**
     * One finished vendor round trip: what the call asked for, what it produced, how long it took,
     * and how it failed when it did. Emitted after every operation settles, so a consumer can make
     * media work visible in its own traces without wrapping the seam.
     * @param observation - the finished call, success or failure.
     * @mode emit
     */
    'media/observation'(observation: MediaObservation): void
  }
}

/**
 * Config for the media seam: `provider` pins which registered implementation wins. Omitted, a single
 * usable implementation auto-selects; the seam deliberately reads no environment variable, so a
 * deployment states its choice in one place.
 */
export interface MediaRuntimeConfig {
  /** Explicit media provider id. Omitted = auto-select when exactly one is usable. */
  readonly provider?: string
}

/**
 * The media capability service. Registered as `ctx.media` (one instance per context).
 *
 * Selection semantics, resolved at call time:
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `MEDIA_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable → `MEDIA_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `MEDIA_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `MEDIA_PROVIDER_UNAVAILABLE`.
 */
export class MediaRuntime extends Service {
  /** Selection config; see {@link MediaRuntimeConfig}. */
  static Config: z<MediaRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private providers = new Map<string, MediaProvider>()
  private readonly providerId: string | undefined

  /**
   * @param ctx - owning context; the service is published as `ctx.media`.
   * @param config - selection config.
   */
  constructor(ctx: Context, config: MediaRuntimeConfig = {}) {
    super(ctx, 'media')
    this.providerId = config.provider
  }

  /**
   * Register one media provider implementation. Throws {@link MediaError}
   * `MEDIA_PROVIDER_DUPLICATE` when its id is already registered.
   * @param provider - the implementation; its `id` is the registry key.
   * @returns the disposer that unregisters it; disposed with the calling fiber.
   */
  registerProvider(provider: MediaProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new MediaError(`a media provider with id "${provider.id}" is already registered`, 'MEDIA_PROVIDER_DUPLICATE')
    }
    const providers = this.providers
    const dispose = this.ctx.effect(function* () {
      providers.set(provider.id, provider)
      yield () => providers.delete(provider.id)
    }, 'media.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; the registry's disposer API is synchronous.
    return () => void dispose()
  }

  /**
   * Produce images through the selected provider.
   * @param request - prompt, size hints, and vendor target.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the decoded images.
   */
  async generateImage(request: MediaImageRequest, signal?: AbortSignal): Promise<MediaImageResult> {
    return await this.observed('generateImage', request, async (provider) => {
      const result = await provider.generateImage(request, signal)
      return {
        value: result,
        output: {
          bytes: result.images.reduce((total, image) => total + image.bytes.length, 0),
          contentType: result.images[0]?.contentType ?? '',
          artifacts: result.images.length,
        },
      }
    }, {
      textChars: request.prompt.length,
      imageCount: 0,
      audioCount: 0,
      videoCount: 0,
      ...request.resolution === undefined ? {} : { resolution: request.resolution },
      ...request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio },
      count: Math.max(1, Math.trunc(request.count ?? 1)),
    })
  }

  /**
   * Submit a video job through the selected provider.
   * @param request - prompt, duration, references, and vendor target.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns a job to poll or an already finished video.
   */
  async submitVideo(request: MediaVideoRequest, signal?: AbortSignal): Promise<MediaVideoSubmission> {
    return await this.observed('submitVideo', request, async (provider) => {
      const result = await provider.submitVideo(request, signal)
      return {
        value: result,
        output: {
          bytes: result.video?.bytes.length ?? 0,
          contentType: result.video?.contentType ?? '',
          ...result.jobId === undefined ? {} : { jobId: result.jobId },
        },
      }
    }, {
      textChars: request.prompt.length,
      imageCount: request.talkingHead?.images.length ?? request.images?.length ?? 0,
      audioCount: request.talkingHead?.audios?.length ?? 0,
      videoCount: request.talkingHead?.videos?.length ?? 0,
      durationSeconds: request.durationSeconds,
      ...request.resolution === undefined ? {} : { resolution: request.resolution },
      ...request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio },
    })
  }

  /**
   * Poll one submitted video job through the selected provider.
   * @param request - the job id and vendor target.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the normalized job state.
   */
  async pollVideo(request: MediaVideoPollRequest, signal?: AbortSignal): Promise<MediaVideoStatus> {
    // 轮询没有"输入文本"可言，产出摘要只在真拿到成片时才有体积；jobId 记进产出侧，
    // 观察者据此把一条任务的全部轮询认成同一件事。
    return await this.observed('pollVideo', request, async (provider) => {
      const result = await provider.pollVideo(request, signal)
      return {
        value: result,
        ...result.video === undefined ? {} : {
          output: { bytes: result.video.bytes.length, contentType: result.video.contentType, jobId: request.jobId },
        },
      }
    }, { textChars: 0, imageCount: 0, audioCount: 0, videoCount: 0 })
  }

  /**
   * Run one provider call, measure it, and report it.
   *
   * Every operation goes through here so an observer sees exactly one observation per vendor round
   * trip — including failures that never reached a provider (selection errors), where the route and
   * the failure classification are the caller's only clue.
   *
   * @param operation - which operation ran.
   * @param request - the call target (route and model) the caller named.
   * @param call - the provider invocation, returning the caller's value plus its output summary.
   * @param input - what the call asked for.
   * @returns the provider's value, unchanged.
   */
  private async observed<T>(
    operation: MediaObservation['operation'],
    request: MediaCallTarget,
    call: (provider: MediaProvider) => Promise<{ value: T; output?: MediaObservationOutput }>,
    input: MediaObservationInput,
  ): Promise<T> {
    const started = Date.now()
    try {
      const { value, output } = await call(this.select())
      this.report({
        operation,
        provider: request.provider,
        model: request.model,
        durationMs: Date.now() - started,
        ok: true,
        input,
        ...output === undefined ? {} : { output },
      })
      return value
    }
    catch (error) {
      this.report({
        operation,
        provider: request.provider,
        model: request.model,
        durationMs: Date.now() - started,
        ok: false,
        input,
        ...isMediaError(error) ? { errorCode: error.code } : {},
        ...isMediaError(error) && error.status !== undefined ? { status: error.status } : {},
      })
      throw error
    }
  }

  /**
   * Emit one observation.
   *
   * A listener that throws must not change the call's outcome: reporting is a side channel, and a
   * failed trace write turning into a "vendor failure" would make the caller retry a call that
   * already succeeded.
   *
   * @param observation - the finished call.
   */
  private report(observation: MediaObservation): void {
    try {
      this.ctx.emit('media/observation', observation)
    }
    catch (error) {
      this.ctx.logger.warn('media observation listener failed: ' + String(error))
    }
  }
  /** Resolve the provider for this call, or throw the matching {@link MediaError}. */
  private select(): MediaProvider {
    const configured = this.providerId
    if (configured !== undefined && configured !== '') {
      const provider = this.providers.get(configured)
      if (provider === undefined) {
        throw new MediaError(`configured media provider "${configured}" is not registered`, 'MEDIA_PROVIDER_CONFIGURED_MISSING')
      }
      if (!provider.available()) {
        throw new MediaError(`configured media provider "${configured}" is registered but unavailable`, 'MEDIA_PROVIDER_CONFIGURED_UNAVAILABLE')
      }
      return provider
    }
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) throw new MediaError('no usable media provider is registered', 'MEDIA_PROVIDER_UNAVAILABLE')
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new MediaError(`multiple usable media providers are registered (${ids}); configure one explicitly`, 'MEDIA_PROVIDER_AMBIGUOUS')
    }
    return single
  }
}

export default MediaRuntime
