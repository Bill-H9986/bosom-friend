import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import MediaRuntime, { MediaError } from '@deepseek-ai/dsh-media'
import * as mediaPiAi from '@deepseek-ai/dsh-media-pi-ai'
import type { Config } from '@deepseek-ai/dsh-media-pi-ai'

/** One request the fake vendor received. */
interface Recorded {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: unknown
}

/** A fake vendor: records every request and answers through the test's handler. */
interface Vendor {
  readonly baseURL: string
  readonly requests: Recorded[]
  close(): Promise<void>
}

/** Start a loopback vendor on an ephemeral port. */
async function startVendor(handler: (request: Recorded, response: ServerResponse) => void): Promise<Vendor> {
  const requests: Recorded[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = text
      try {
        body = text === '' ? undefined : JSON.parse(text)
      }
      catch {
        // A non-JSON body stays as text; no handler in these tests sends one.
      }
      const record: Recorded = { method: request.method ?? '', path: request.url ?? '', headers: request.headers, body }
      requests.push(record)
      handler(record, response)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseURL: 'http://127.0.0.1:' + String(port),
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

/** Answer with JSON. */
function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

/** Mount the media seam plus the pi-ai provider. */
async function mount(config: Config): Promise<{ ctx: Context; close: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(MediaRuntime)
  const fiber = await ctx.plugin({ name: mediaPiAi.name, inject: mediaPiAi.inject, apply: mediaPiAi.apply }, config)
  return { ctx, close: () => fiber.dispose() }
}

const AGNES_KEY = 'BF_MEDIA_TEST_KEY'
const vendors: Vendor[] = []

afterEach(async () => {
  Reflect.deleteProperty(process.env, AGNES_KEY)
  await Promise.all(vendors.splice(0).map(vendor => vendor.close()))
})

/** Start a vendor and remember it for teardown. */
async function vendor(handler: (request: Recorded, response: ServerResponse) => void): Promise<Vendor> {
  const started = await startVendor(handler)
  vendors.push(started)
  return started
}

describe('media-pi-ai registration', () => {
  it('is unusable without routes and usable once one is configured', async () => {
    const { ctx, close } = await mount({ providers: {} })
    await expect(ctx.media.generateImage({ provider: 'agnes', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_UNAVAILABLE' }))
    await close()
    expect(ctx.media).toBeDefined()
  })

  it('reports an unknown route instead of calling anything', async () => {
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: 'http://127.0.0.1:1/v1' } } })
    await expect(ctx.media.generateImage({ provider: 'other', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_ROUTE_UNKNOWN' }))
    await close()
  })

  it('fails loud when a named credential ref resolves to nothing', async () => {
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: AGNES_KEY } } })
    await expect(ctx.media.generateImage({ provider: 'agnes', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_CREDENTIAL_MISSING' }))
    await close()
  })

  it('sends the resolved credential as a bearer token', async () => {
    process.env[AGNES_KEY] = 'secret-key'
    const server = await vendor((_request, response) => json(response, 200, { data: [{ b64_json: Buffer.from('img').toString('base64') }] }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', apiKeyEnv: AGNES_KEY } } })
    await ctx.media.generateImage({ provider: 'agnes', model: 'm', prompt: 'p' })
    expect(server.requests[0]?.headers.authorization).toBe('Bearer secret-key')
    await close()
  })

  it('calls a route without a credential ref anonymously', async () => {
    const server = await vendor((_request, response) => json(response, 200, { data: [{ b64_json: Buffer.from('img').toString('base64') }] }))
    const { ctx, close } = await mount({ providers: { local: { baseURL: server.baseURL + '/v1' } } })
    await ctx.media.generateImage({ provider: 'local', model: 'm', prompt: 'p' })
    expect(server.requests[0]?.headers.authorization).toBeUndefined()
    await close()
  })
})

describe('media-pi-ai image generation', () => {
  it('decodes base64 images and reports the size it used', async () => {
    const server = await vendor((_request, response) => json(response, 200, { data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] }))
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    const result = await ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p' })
    expect(result.images).toHaveLength(1)
    expect(Buffer.from(result.images[0]?.bytes ?? new Uint8Array()).toString()).toBe('png-bytes')
    expect(result.acceptedSize).toBe('1024x1024')
    expect(server.requests[0]?.path).toBe('/v1/images/generations')
    await close()
  })

  it('maps tier and ratio onto the Agnes dialect body', async () => {
    const server = await vendor((_request, response) => json(response, 200, { data: [{ b64_json: Buffer.from('x').toString('base64') }] }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    const result = await ctx.media.generateImage({
      provider: 'agnes', model: 'img-model', prompt: 'p', resolution: '720p', aspectRatio: '9:16',
    })
    expect(server.requests[0]?.body).toMatchObject({
      model: 'img-model', prompt: 'p', n: 1, size: '1K', ratio: '9:16', extra_body: { response_format: 'url' },
    })
    expect(result.acceptedSize).toBe('1K')
    await close()
  })

  it('honours a preferred size the route already accepted', async () => {
    const server = await vendor((_request, response) => json(response, 200, { data: [{ b64_json: Buffer.from('x').toString('base64') }] }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    const result = await ctx.media.generateImage({ provider: 'agnes', model: 'm', prompt: 'p', preferredSize: '1080P' })
    expect(result.acceptedSize).toBe('1080P')
    await close()
  })

  it('downloads an image the vendor returned as a URL', async () => {
    const server = await vendor((request, response) => {
      if (request.path === '/img.png') {
        response.writeHead(200, { 'content-type': 'image/png' })
        response.end('downloaded')
        return
      }
      json(response, 200, { data: [{ url: 'http://127.0.0.1:' + request.headers.host?.split(':')[1] + '/img.png' }] })
    })
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    const result = await ctx.media.generateImage({ provider: 'agnes', model: 'm', prompt: 'p' })
    expect(Buffer.from(result.images[0]?.bytes ?? new Uint8Array()).toString()).toBe('downloaded')
    expect(result.images[0]?.contentType).toBe('image/png')
    await close()
  })

  it('retries the OpenAI dialect once with the default size after a 400', async () => {
    let calls = 0
    const server = await vendor((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 400, { error: 'bad size' })
        return
      }
      json(response, 200, { data: [{ b64_json: Buffer.from('ok').toString('base64') }] })
    })
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    const result = await ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p', resolution: '512x512' })
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]?.body).toMatchObject({ size: '512x512' })
    expect(server.requests[1]?.body).toMatchObject({ size: '1024x1024' })
    expect(result.acceptedSize).toBe('1024x1024')
    await close()
  })

  it('reports a rejected first image with the vendor status', async () => {
    const server = await vendor((_request, response) => json(response, 429, { error: 'slow down' }))
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    await expect(ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_REJECTED', status: 429 }))
    await close()
  })

  it('keeps the images that arrived when a later one fails', async () => {
    let calls = 0
    const server = await vendor((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 200, { data: [{ b64_json: Buffer.from('first').toString('base64') }] })
        return
      }
      json(response, 500, { error: 'boom' })
    })
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    const result = await ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p', count: 3 })
    expect(result.images).toHaveLength(1)
    expect(server.requests).toHaveLength(2)
    await close()
  })

  it('reports a document without an image as MEDIA_VENDOR_NO_RESULT', async () => {
    const server = await vendor((_request, response) => json(response, 200, { data: [] }))
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    await expect(ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_NO_RESULT' }))
    await close()
  })

  it('reports an undeliverable image URL as MEDIA_VENDOR_NO_RESULT', async () => {
    const server = await vendor((request, response) => {
      if (request.path === '/missing.png') {
        json(response, 404, { error: 'gone' })
        return
      }
      json(response, 200, { data: [{ url: 'http://127.0.0.1:' + request.headers.host?.split(':')[1] + '/missing.png' }] })
    })
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    await expect(ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_NO_RESULT' }))
    await close()
  })

  it('skips an undeliverable image and keeps the next one', async () => {
    let calls = 0
    const server = await vendor((request, response) => {
      if (request.path === '/missing.png') {
        response.writeHead(200, { 'content-type': 'image/png' })
        response.end('')
        return
      }
      calls += 1
      if (calls === 1) {
        json(response, 200, { data: [{ url: 'http://127.0.0.1:' + request.headers.host?.split(':')[1] + '/missing.png' }] })
        return
      }
      json(response, 200, { data: [{ b64_json: Buffer.from('second').toString('base64') }] })
    })
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    const result = await ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p', count: 2 })
    expect(result.images).toHaveLength(1)
    expect(Buffer.from(result.images[0]?.bytes ?? new Uint8Array()).toString()).toBe('second')
    await close()
  })

  it('skips a base64 payload that decodes to nothing', async () => {
    let calls = 0
    const server = await vendor((_request, response) => {
      calls += 1
      json(response, 200, { data: [{ b64_json: '!!!!' }] })
    })
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    await expect(ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_NO_RESULT' }))
    expect(calls).toBe(1)
    await close()
  })

  it('accepts an image download that carries no content type', async () => {
    const server = await vendor((request, response) => {
      if (request.path === '/img') {
        response.writeHead(200)
        response.end('raw')
        return
      }
      json(response, 200, { data: [{ url: 'http://' + String(request.headers.host) + '/img' }] })
    })
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    const result = await ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p' })
    expect(result.images[0]?.contentType).toBe('')
    await close()
  })

  it('reports an empty base64 payload as MEDIA_VENDOR_NO_RESULT', async () => {
    const server = await vendor((_request, response) => json(response, 200, { data: [{ b64_json: '' }] }))
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    await expect(ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_NO_RESULT' }))
    await close()
  })

  it('reports a transport failure as MEDIA_VENDOR_UNREACHABLE', async () => {
    const server = await vendor((_request, response) => json(response, 200, {}))
    const baseURL = server.baseURL
    await server.close()
    vendors.splice(vendors.indexOf(server), 1)
    const { ctx, close } = await mount({ providers: { openai: { baseURL: baseURL + '/v1' } } })
    await expect(ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_UNREACHABLE' }))
    await close()
  })
})

describe('media-pi-ai video', () => {
  it('submits an Agnes job, downgrades once on a reported size list, and polls it to a finished video', async () => {
    let created = 0
    const server = await vendor((request, response) => {
      if (request.path.startsWith('/agnesapi')) {
        json(response, 200, { status: 'completed', url: 'http://' + String(request.headers.host) + '/clip.mp4' })
        return
      }
      if (request.path === '/clip.mp4') {
        response.writeHead(200, { 'content-type': 'video/mp4' })
        response.end('mp4-bytes')
        return
      }
      created += 1
      if (created === 1) {
        json(response, 400, { data: { valid_sizes: ['720P'] } })
        return
      }
      json(response, 200, { video_id: 'job-1' })
    })
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    const submission = await ctx.media.submitVideo({
      provider: 'agnes', model: 'agnes-video-2.5', prompt: 'p', durationSeconds: 30, resolution: '1080p', aspectRatio: '9:16',
    })
    expect(submission).toEqual({ model: 'agnes-video-2.5', jobId: 'job-1', acceptedSize: '720P' })
    expect(server.requests[0]?.path).toBe('/v1/videos')
    expect(server.requests[0]?.body).toMatchObject({ seconds: '12', size: '1080P', aspect_ratio: '9:16', mode: 'text' })
    expect(server.requests[1]?.body).toMatchObject({ size: '720P' })

    const status = await ctx.media.pollVideo({ provider: 'agnes', model: 'agnes-video-2.5', jobId: 'job-1' })
    expect(status.state).toBe('completed')
    expect(Buffer.from(status.video?.bytes ?? new Uint8Array()).toString()).toBe('mp4-bytes')
    expect(server.requests[2]?.path).toContain('/agnesapi?video_id=job-1&model_name=agnes-video-2.5')
    await close()
  })

  it('carries reference images and talking-head audio into the Agnes mode block', async () => {
    const server = await vendor((_request, response) => json(response, 200, { video_id: 'job-2' }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await ctx.media.submitVideo({
      provider: 'agnes', model: 'agnes-video-2.5', prompt: 'p', durationSeconds: 5, images: ['data:image/png;base64,AA'],
    })
    expect(server.requests[0]?.body).toMatchObject({ mode: 'keyframe', first_frame: 'data:image/png;base64,AA' })

    await ctx.media.submitVideo({
      provider: 'agnes',
      model: 'agnes-video-2.5',
      prompt: 'p',
      durationSeconds: 5,
      talkingHead: { images: ['portrait'], audios: ['voice'], seed: 7 },
    })
    expect(server.requests[1]?.body).toMatchObject({ mode: 'reference', images: ['portrait'], audios: ['voice'], seed: 7 })
    await close()
  })

  it('returns a finished video from an OpenAI-dialect submission', async () => {
    const server = await vendor((request, response) => {
      if (request.path === '/clip.mp4') {
        response.writeHead(200, { 'content-type': 'video/mp4' })
        response.end('direct')
        return
      }
      json(response, 200, { output: ['http://' + String(request.headers.host) + '/clip.mp4'] })
    })
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    const submission = await ctx.media.submitVideo({ provider: 'openai', model: 'm', prompt: 'p', durationSeconds: 6, images: ['ref'] })
    expect(Buffer.from(submission.video?.bytes ?? new Uint8Array()).toString()).toBe('direct')
    expect(server.requests[0]?.path).toBe('/v1/videos/generations')
    expect(server.requests[0]?.body).toMatchObject({ duration: 6, image: 'ref' })
    await close()
  })

  it('refuses a talking-head request on a dialect without audio input', async () => {
    const server = await vendor((_request, response) => json(response, 200, { video_id: 'job' }))
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    await expect(ctx.media.submitVideo({
      provider: 'openai',
      model: 'm',
      prompt: 'p',
      durationSeconds: 5,
      talkingHead: { images: ['portrait'], audios: ['voice'], seed: 1 },
    })).rejects.toThrow(expect.objectContaining({ code: 'MEDIA_OPERATION_UNSUPPORTED' }))
    expect(server.requests).toHaveLength(0)
    await close()
  })

  it('returns a job id when the OpenAI dialect submits asynchronously', async () => {
    const server = await vendor((_request, response) => json(response, 200, { data: { id: 'task-9' } }))
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    const submission = await ctx.media.submitVideo({ provider: 'openai', model: 'm', prompt: 'p', durationSeconds: 6 })
    expect(submission.jobId).toBe('task-9')
    await close()
  })

  it('does not retry when the rejection reports no usable size', async () => {
    let calls = 0
    const server = await vendor((_request, response) => {
      calls += 1
      json(response, 400, { data: { valid_sizes: [] } })
    })
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.submitVideo({ provider: 'agnes', model: 'm', prompt: 'p', durationSeconds: 5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_REJECTED', status: 400 }))
    expect(calls).toBe(1)
    await close()
  })

  it('reports a submission without job id or url as MEDIA_VENDOR_NO_RESULT', async () => {
    const server = await vendor((_request, response) => json(response, 200, { ok: true }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.submitVideo({ provider: 'agnes', model: 'm', prompt: 'p', durationSeconds: 5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_NO_RESULT' }))
    await close()
  })

  it('reports a rejected submission with the vendor status', async () => {
    const server = await vendor((_request, response) => json(response, 403, { error: 'denied' }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.submitVideo({ provider: 'agnes', model: 'm', prompt: 'p', durationSeconds: 5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_REJECTED', status: 403 }))
    await close()
  })

  it('polls an OpenAI-dialect job through its status endpoint', async () => {
    const server = await vendor((request, response) => {
      if (request.path === '/clip.mp4') {
        response.writeHead(200, { 'content-type': 'video/mp4' })
        response.end('done')
        return
      }
      json(response, 200, { status: 'completed', url: 'http://' + String(request.headers.host) + '/clip.mp4' })
    })
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    const status = await ctx.media.pollVideo({ provider: 'openai', model: 'm', jobId: 'task-9' })
    expect(status.state).toBe('completed')
    expect(server.requests[0]?.path).toBe('/v1/videos/task-9')
    await close()
  })

  it('reports a pending job as pending', async () => {
    const server = await vendor((_request, response) => json(response, 200, { status: 'processing' }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.pollVideo({ provider: 'agnes', model: 'm', jobId: 'j' })).resolves.toEqual({ state: 'pending' })
    await close()
  })

  it('reports a failed job with the vendor reason', async () => {
    const server = await vendor((_request, response) => json(response, 200, { status: 'failed', error: 'nsfw' }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.pollVideo({ provider: 'agnes', model: 'm', jobId: 'j' })).resolves.toEqual({ state: 'failed', error: 'nsfw' })
    await close()
  })

  it('reports a failed job without a reason as a bare failure', async () => {
    const server = await vendor((_request, response) => json(response, 200, { status: 'failed' }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.pollVideo({ provider: 'agnes', model: 'm', jobId: 'j' })).resolves.toEqual({ state: 'failed' })
    await close()
  })

  it('reports a completed job without an artifact as MEDIA_VENDOR_NO_RESULT', async () => {
    const server = await vendor((_request, response) => json(response, 200, { status: 'completed' }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.pollVideo({ provider: 'agnes', model: 'm', jobId: 'j' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_NO_RESULT' }))
    await close()
  })

  it('reports a non-JSON status body as pending rather than failing', async () => {
    const server = await vendor((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>gateway</html>')
    })
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.pollVideo({ provider: 'agnes', model: 'm', jobId: 'j' })).resolves.toEqual({ state: 'pending' })
    await close()
  })

  it('treats an empty status body as pending', async () => {
    const server = await vendor((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('')
    })
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.pollVideo({ provider: 'agnes', model: 'm', jobId: 'j' })).resolves.toEqual({ state: 'pending' })
    await close()
  })

  it('forwards a caller signal to the vendor request', async () => {
    const server = await vendor((_request, response) => json(response, 200, { status: 'processing' }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    const controller = new AbortController()
    await expect(ctx.media.pollVideo({ provider: 'agnes', model: 'm', jobId: 'j' }, controller.signal)).resolves.toEqual({ state: 'pending' })
    controller.abort()
    await expect(ctx.media.pollVideo({ provider: 'agnes', model: 'm', jobId: 'j' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_UNREACHABLE' }))
    await close()
  })

  it('reports a rejection with an empty body without a detail', async () => {
    const server = await vendor((_request, response) => {
      response.writeHead(500)
      response.end('')
    })
    const { ctx, close } = await mount({ providers: { openai: { baseURL: server.baseURL + '/v1' } } })
    const error = await ctx.media.generateImage({ provider: 'openai', model: 'm', prompt: 'p' }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(MediaError)
    expect((error as MediaError).status).toBe(500)
    expect((error as MediaError).detail).toBeUndefined()
    await close()
  })

  it('reports a rejected poll with the vendor status', async () => {
    const server = await vendor((_request, response) => json(response, 429, { error: 'slow down' }))
    const { ctx, close } = await mount({ providers: { agnes: { baseURL: server.baseURL + '/v1', api: 'agnes' } } })
    await expect(ctx.media.pollVideo({ provider: 'agnes', model: 'm', jobId: 'j' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_VENDOR_REJECTED', status: 429 }))
    await close()
  })
})

describe('media-pi-ai configuration sources', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  /** A throwaway directory for the settings and credential documents. */
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'media-pi-ai-'))
    dirs.push(dir)
    return dir
  }

  it('takes its route set from the media-pi-ai settings section', async () => {
    const dir = await tempDir()
    const server = await vendor((_request, response) => json(response, 200, { data: [{ b64_json: Buffer.from('from-settings').toString('base64') }] }))
    const ctx = new Context()
    await ctx.plugin(MediaRuntime)
    const settings = await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    const fiber = await ctx.plugin({ name: mediaPiAi.name, inject: mediaPiAi.inject, apply: mediaPiAi.apply }, { providers: {} })
    await expect(ctx.media.generateImage({ provider: 'local', model: 'm', prompt: 'p' }))
      .rejects.toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_UNAVAILABLE' }))
    // The provider attaches its settings section when the seam becomes available, which cordis
    // settles on a later tick than plugin() resolving.
    await vi.waitFor(() => {
      expect(ctx.settings.describe().map(item => item.ns)).toContain('media-pi-ai')
    })

    await ctx.settings.update('media-pi-ai', { providers: { local: { baseURL: server.baseURL + '/v1' } } })
    const result = await ctx.media.generateImage({ provider: 'local', model: 'm', prompt: 'p' })
    expect(Buffer.from(result.images[0]?.bytes ?? new Uint8Array()).toString()).toBe('from-settings')

    await fiber.dispose()
    await settings.dispose()
  })

  it('resolves a route credential through the credentials seam', async () => {
    const dir = await tempDir()
    const server = await vendor((_request, response) => json(response, 200, { data: [{ b64_json: Buffer.from('seam').toString('base64') }] }))
    const ctx = new Context()
    await ctx.plugin(MediaRuntime)
    const credentials = await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    const fiber = await ctx.plugin({ name: mediaPiAi.name, inject: mediaPiAi.inject, apply: mediaPiAi.apply }, {
      providers: { route: { baseURL: server.baseURL + '/v1', apiKeyEnv: 'BF_SEAM_KEY' } },
    })
    await ctx.credentials.set(credentialRef('BF_SEAM_KEY'), 'seam-secret')
    await ctx.media.generateImage({ provider: 'route', model: 'm', prompt: 'p' })
    expect(server.requests[0]?.headers.authorization).toBe('Bearer seam-secret')

    await fiber.dispose()
    await credentials.dispose()
  })
})
