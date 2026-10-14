import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MediaRuntime, {
  MediaError,
  isMediaError,
  type MediaImageRequest,
  type MediaImageResult,
  type MediaObservation,
  type MediaProvider,
  type MediaVideoStatus,
} from '@deepseek-ai/dsh-media'

/** A scripted media provider: every operation answers with the same marker. */
function makeProvider(id: string, usable: boolean, marker = id): MediaProvider {
  const image: MediaImageResult = { images: [{ bytes: new Uint8Array([1]), contentType: 'image/png' }], model: marker }
  return {
    id,
    available: () => usable,
    generateImage: () => Promise.resolve(image),
    submitVideo: () => Promise.resolve({ model: marker, jobId: marker }),
    pollVideo: () => Promise.resolve({ state: 'pending' } as MediaVideoStatus),
  }
}

/** Mount a MediaRuntime on a fresh root context. */
async function mountMedia(config: { provider?: string } = {}): Promise<{ ctx: Context; media: MediaRuntime }> {
  const ctx = new Context()
  await ctx.plugin(MediaRuntime, config)
  return { ctx, media: ctx.media }
}

const imageRequest: MediaImageRequest = { provider: 'route', model: 'm', prompt: 'p' }

describe('MediaRuntime registration', () => {
  it('registers a provider and unregisters it through the returned disposer', async () => {
    const { media } = await mountMedia()
    const dispose = media.registerProvider(makeProvider('pi-ai', true))
    await expect(media.generateImage(imageRequest)).resolves.toMatchObject({ model: 'pi-ai' })
    dispose()
    await expect(media.generateImage(imageRequest)).rejects.toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_UNAVAILABLE' }))
  })

  it('rejects a duplicate provider id', async () => {
    const { media } = await mountMedia()
    media.registerProvider(makeProvider('pi-ai', true))
    expect(() => media.registerProvider(makeProvider('pi-ai', true)))
      .toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_DUPLICATE' }))
  })

  it('drops registrations when the contributing fiber is disposed', async () => {
    const { ctx, media } = await mountMedia()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.media.registerProvider(makeProvider('pi-ai', true))
    }, { inject: ['media'] }))
    await expect(media.generateImage(imageRequest)).resolves.toMatchObject({ model: 'pi-ai' })
    await fiber.dispose()
    await expect(media.generateImage(imageRequest)).rejects.toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_UNAVAILABLE' }))
  })
})

describe('MediaRuntime selection', () => {
  it('fails with MEDIA_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { media } = await mountMedia()
    await expect(media.generateImage(imageRequest)).rejects.toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_UNAVAILABLE' }))
  })

  it('fails with MEDIA_PROVIDER_UNAVAILABLE when every provider is unusable', async () => {
    const { media } = await mountMedia()
    media.registerProvider(makeProvider('pi-ai', false))
    await expect(media.generateImage(imageRequest)).rejects.toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_UNAVAILABLE' }))
  })

  it('fails with MEDIA_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { media } = await mountMedia({ provider: 'missing' })
    media.registerProvider(makeProvider('pi-ai', true))
    await expect(media.generateImage(imageRequest)).rejects.toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('fails with MEDIA_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { media } = await mountMedia({ provider: 'pi-ai' })
    media.registerProvider(makeProvider('pi-ai', false))
    await expect(media.generateImage(imageRequest)).rejects.toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('fails with MEDIA_PROVIDER_AMBIGUOUS when several providers are usable and none is configured', async () => {
    const { media } = await mountMedia()
    media.registerProvider(makeProvider('one', true))
    media.registerProvider(makeProvider('two', true))
    await expect(media.generateImage(imageRequest)).rejects.toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_AMBIGUOUS' }))
  })

  it('treats an empty configured id as unconfigured', async () => {
    const { media } = await mountMedia({ provider: '' })
    media.registerProvider(makeProvider('pi-ai', true, 'picked'))
    await expect(media.generateImage(imageRequest)).resolves.toMatchObject({ model: 'picked' })
  })

  it('selects the configured provider when it is registered and usable', async () => {
    const { media } = await mountMedia({ provider: 'pi-ai' })
    media.registerProvider(makeProvider('pi-ai', true, 'configured'))
    media.registerProvider(makeProvider('other', true))
    await expect(media.generateImage(imageRequest)).resolves.toMatchObject({ model: 'configured' })
  })

  it('keeps an unusable provider out of the way when exactly one other provider is usable', async () => {
    const { media } = await mountMedia()
    media.registerProvider(makeProvider('broken', false))
    media.registerProvider(makeProvider('pi-ai', true, 'picked'))
    await expect(media.generateImage(imageRequest)).resolves.toMatchObject({ model: 'picked' })
  })
})

describe('MediaRuntime operations', () => {
  it('forwards the request and signal of every operation to the selected provider', async () => {
    const { media } = await mountMedia()
    const generateImage = vi.fn(() => Promise.resolve({ images: [], model: 'm' } satisfies MediaImageResult))
    const submitVideo = vi.fn(() => Promise.resolve({ model: 'm', jobId: 'job' }))
    const pollVideo = vi.fn(() => Promise.resolve({ state: 'failed', error: 'boom' } as MediaVideoStatus))
    media.registerProvider({ id: 'pi-ai', available: () => true, generateImage, submitVideo, pollVideo })
    const controller = new AbortController()

    await expect(media.generateImage(imageRequest, controller.signal)).resolves.toEqual({ images: [], model: 'm' })
    await expect(media.submitVideo({ provider: 'route', model: 'm', prompt: 'p', durationSeconds: 5 }, controller.signal))
      .resolves.toEqual({ model: 'm', jobId: 'job' })
    await expect(media.pollVideo({ provider: 'route', model: 'm', jobId: 'job' }, controller.signal))
      .resolves.toEqual({ state: 'failed', error: 'boom' })

    expect(generateImage).toHaveBeenCalledWith(imageRequest, controller.signal)
    expect(submitVideo.mock.calls[0]?.[1]).toBe(controller.signal)
    expect(pollVideo.mock.calls[0]?.[1]).toBe(controller.signal)
  })
})

describe('MediaError', () => {
  it('carries only the message and code when the vendor never answered', () => {
    const error = new MediaError('no answer', 'MEDIA_VENDOR_UNREACHABLE')
    expect(error.name).toBe('MediaError')
    expect(error.code).toBe('MEDIA_VENDOR_UNREACHABLE')
    expect(error.status).toBeUndefined()
    expect(error.detail).toBeUndefined()
  })

  it('carries the vendor status and body excerpt when it did answer', () => {
    const error = new MediaError('rejected', 'MEDIA_VENDOR_REJECTED', { status: 429, detail: 'slow down' })
    expect(error.status).toBe(429)
    expect(error.detail).toBe('slow down')
  })
})

/**
 * 媒体留痕（D3）：能力面每完成一次厂商往返就报一条观察——输入、产出、耗时、失败分类。
 *
 * 判据钉在三件事上：成功与失败都报、**选不到提供方也要报**（那时候路由与分类是调用方唯一的线索）、
 * 观察者抛错不改调用的结果（留痕是旁路，不能让一次写盘失败冒充成厂商失败）。
 */
describe('media/observation', () => {
  it('成功的调用报出输入、产出与耗时', async () => {
    const { ctx, media } = await mountMedia()
    const seen: MediaObservation[] = []
    ctx.on('media/observation', (observation) => { seen.push(observation) })
    media.registerProvider(makeProvider('p', true))
    await media.generateImage({ provider: 'route-a', model: 'm-1', prompt: '一二三', count: 2, resolution: '1K', aspectRatio: '3:4' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      operation: 'generateImage',
      provider: 'route-a',
      model: 'm-1',
      ok: true,
      input: { textChars: 3, imageCount: 0, audioCount: 0, videoCount: 0, count: 2, resolution: '1K', aspectRatio: '3:4' },
      output: { bytes: 1, contentType: 'image/png', artifacts: 1 },
    })
    expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('失败的调用也报一条：分类与厂商状态码都在', async () => {
    const { ctx, media } = await mountMedia()
    const seen: MediaObservation[] = []
    ctx.on('media/observation', (observation) => { seen.push(observation) })
    media.registerProvider({
      ...makeProvider('p', true),
      pollVideo: () => Promise.reject(new MediaError('rejected', 'MEDIA_VENDOR_REJECTED', { status: 503 })),
    })
    await expect(media.pollVideo({ provider: 'voice', model: 'tts-1', jobId: 'job' })).rejects.toThrow()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      operation: 'pollVideo',
      provider: 'voice',
      ok: false,
      errorCode: 'MEDIA_VENDOR_REJECTED',
      status: 503,
      input: { textChars: 0, imageCount: 0, audioCount: 0, videoCount: 0 },
    })
    expect(seen[0]?.output).toBeUndefined()
  })

  it('选不到提供方时照样报：路由与分类是调用方唯一的线索', async () => {
    const { ctx, media } = await mountMedia()
    const seen: MediaObservation[] = []
    ctx.on('media/observation', (observation) => { seen.push(observation) })
    await expect(media.pollVideo({ provider: 'bf-voice', model: 'tts-1', jobId: 'job' })).rejects.toThrow()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      operation: 'pollVideo',
      provider: 'bf-voice',
      model: 'tts-1',
      ok: false,
      errorCode: 'MEDIA_PROVIDER_UNAVAILABLE',
    })
  })

  it('视频下单把 jobId 记进产出侧；轮询拿到成片才报体积', async () => {
    const { ctx, media } = await mountMedia()
    const seen: MediaObservation[] = []
    ctx.on('media/observation', (observation) => { seen.push(observation) })
    media.registerProvider({
      ...makeProvider('p', true),
      pollVideo: () => Promise.resolve({ state: 'completed', video: { bytes: new Uint8Array([1, 2, 3]), contentType: 'video/mp4' } }),
    })
    await media.submitVideo({ provider: 'route-a', model: 'v-1', prompt: 'x', durationSeconds: 5, images: ['a', 'b'] })
    await media.pollVideo({ provider: 'route-a', model: 'v-1', jobId: 'job-7' })
    expect(seen[0]).toMatchObject({ operation: 'submitVideo', ok: true, input: { imageCount: 2, durationSeconds: 5 }, output: { jobId: 'p' } })
    expect(seen[1]).toMatchObject({ operation: 'pollVideo', ok: true, output: { bytes: 3, contentType: 'video/mp4', jobId: 'job-7' } })
  })

  it('观察者抛错不改变调用结果（一次留痕失败不许冒充厂商失败）', async () => {
    const { ctx, media } = await mountMedia()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    ctx.on('media/observation', () => { throw new Error('trace sink down') })
    media.registerProvider(makeProvider('p', true))
    const result = await media.generateImage({ provider: 'route-a', model: 'm', prompt: 'hi' })
    expect(result.images.length).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

/**
 * 一个进程里可以同时存在这个包的**两份物理副本**（pnpm 按依赖方的 peer 集合各注入一份），
 * 提供方那一份抛出的错误不是调用方 import 的那个类的实例——`instanceof` 于是全线失效：
 * 产品侧读不到状态码、429/5xx 不再重试，一条已经跑成十镜的长视频被一次瞬时厂商 503 判死
 * （DEF-169，2026-09-23 真机对账实测）。判据必须跨副本成立。
 */
describe('isMediaError：跨副本识别（DEF-169）', () => {
  it('认得本副本抛出的 MediaError', () => {
    expect(isMediaError(new MediaError('rejected', 'MEDIA_VENDOR_REJECTED', { status: 503 }))).toBe(true)
  })

  it('认得**另一份副本**抛出的 MediaError（同名字段 + 同一个 Symbol.for 标记）', () => {
    // 另一份副本的实例在结构上就是这样：类不同、字段相同、标记是同一个 Symbol.for。
    const foreign = Object.assign(new Error('media-pi-ai: video submission was rejected with HTTP 503'), {
      name: 'MediaError',
      code: 'MEDIA_VENDOR_REJECTED',
      status: 503,
      [Symbol.for('@deepseek-ai/dsh-media/MediaError')]: true,
    })
    expect(foreign instanceof MediaError).toBe(false)
    expect(isMediaError(foreign)).toBe(true)
  })

  it('不认普通错误、空值与非对象', () => {
    expect(isMediaError(new Error('boom'))).toBe(false)
    expect(isMediaError(undefined)).toBe(false)
    expect(isMediaError(null)).toBe(false)
    expect(isMediaError('MediaError')).toBe(false)
  })
})
