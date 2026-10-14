import { describe, expect, it } from 'vitest'
import type { PiAiMediaRoute } from '../src/config.ts'
import {
  agnesImageRatio,
  agnesImageTier,
  agnesModeFields,
  agnesTalkingHeadFields,
  agnesVideoRatio,
  agnesVideoSeconds,
  agnesVideoSize,
  bestSizeFor,
  excerpt,
  firstVideoSize,
  imageBody,
  imageEndpoint,
  imageSizeOf,
  originOf,
  pickImageCandidate,
  pickTaskId,
  pickVideoId,
  pickVideoUrl,
  validSizesOf,
  versionedPath,
  videoBody,
  videoCreateEndpoint,
  videoStatusEndpoint,
} from '../src/vendor.ts'

const openai: PiAiMediaRoute = { baseURL: 'https://vendor.example/v1' }
const bare: PiAiMediaRoute = { baseURL: 'https://vendor.example/' }
const agnes: PiAiMediaRoute = { baseURL: 'https://vendor.example/v1', api: 'agnes' }

describe('endpoints', () => {
  it('keeps a version suffix that is already there and adds one that is not', () => {
    expect(versionedPath('https://vendor.example/v1', '/images/generations')).toBe('https://vendor.example/v1/images/generations')
    expect(versionedPath('https://vendor.example/', '/images/generations')).toBe('https://vendor.example/v1/images/generations')
    expect(versionedPath('https://vendor.example/v2/', '/x')).toBe('https://vendor.example/v2/x')
  })

  it('derives the origin used by endpoints outside the version prefix', () => {
    expect(originOf('https://vendor.example/v1')).toBe('https://vendor.example')
  })

  it('builds every endpoint per dialect', () => {
    expect(imageEndpoint(openai)).toBe('https://vendor.example/v1/images/generations')
    expect(videoCreateEndpoint(openai)).toBe('https://vendor.example/v1/videos/generations')
    expect(videoCreateEndpoint(agnes)).toBe('https://vendor.example/v1/videos')
    expect(videoStatusEndpoint(openai, 'a b', 'm')).toBe('https://vendor.example/v1/videos/a%20b')
    expect(videoStatusEndpoint(agnes, 'a b', 'm 1')).toBe('https://vendor.example/agnesapi?video_id=a%20b&model_name=m%201')
  })
})

describe('agnes dialect mappings', () => {
  it('maps image tiers and ratios onto the vendor whitelist', () => {
    expect(agnesImageTier('720p')).toBe('1K')
    expect(agnesImageTier('1080p')).toBe('2K')
    expect(agnesImageTier(undefined)).toBe('2K')
    expect(agnesImageRatio('9:16')).toBe('9:16')
    expect(agnesImageRatio('weird')).toBe('1:1')
    expect(agnesImageRatio(undefined)).toBe('1:1')
  })

  it('maps video ratios and clamps durations', () => {
    expect(agnesVideoRatio('4:3')).toBe('4:3')
    expect(agnesVideoRatio('21:9')).toBe('21:9')
    expect(agnesVideoRatio('nope')).toBe('9:16')
    expect(agnesVideoSeconds(30)).toBe('12')
    expect(agnesVideoSeconds(1)).toBe('4')
    expect(agnesVideoSeconds(6.4)).toBe('6')
    expect(agnesVideoSeconds(Number.NaN)).toBe('4')
  })

  it('picks the highest size a model supports within the requested tier', () => {
    expect(agnesVideoSize('agnes-video-2.5', '1080p')).toBe('1080P')
    expect(agnesVideoSize('agnes-video-2.5', '2K')).toBe('2K')
    expect(agnesVideoSize('agnes-video-2.5-flash', '1080p')).toBe('720P')
    expect(agnesVideoSize('unlisted-model', '2K')).toBe('720P')
    expect(agnesVideoSize('unlisted-model', '720P')).toBe('720P')
    expect(agnesVideoSize('agnes-video-2.5', '1K')).toBe('1K')
  })

  it('builds the reference mode block per image count', () => {
    expect(agnesModeFields([])).toEqual({ mode: 'text' })
    expect(agnesModeFields(['one'])).toEqual({ mode: 'keyframe', first_frame: 'one' })
    expect(agnesModeFields(['one', 'two'])).toEqual({ mode: 'keyframe', first_frame: 'one', last_frame: 'two' })
    expect(agnesModeFields(['1', '2', '3', '4', '5', '6'])).toEqual({ mode: 'reference', images: ['1', '2', '3', '4', '5'] })
  })

  it('truncates talking-head references to the vendor limits', () => {
    const fields = agnesTalkingHeadFields({
      images: ['1', '2', '3', '4', '5', '6'],
      audios: ['a', 'b', 'c', 'd'],
      seed: 3,
    })
    expect(fields).toEqual({ mode: 'reference', images: ['1', '2', '3', '4', '5'], audios: ['a', 'b', 'c'], seed: 3 })
  })

  it('carries a reference video only when the request named one, with only the keys the caller set', () => {
    const bare = agnesTalkingHeadFields({ images: ['1'], videos: [{ url: 'https://x/in.mp4' }], seed: 7 })
    expect(bare).toEqual({ mode: 'reference', images: ['1'], videos: [{ url: 'https://x/in.mp4' }], seed: 7 })
    const full = agnesTalkingHeadFields({
      images: ['1'],
      videos: [{ url: 'https://x/in.mp4', startSeconds: 2, requireAudio: false }],
      seed: 7,
    })
    expect(full).toEqual({
      mode: 'reference',
      images: ['1'],
      videos: [{ url: 'https://x/in.mp4', start_seconds: 2, require_audio: false }],
      seed: 7,
    })
    const capped = agnesTalkingHeadFields({
      images: ['1'],
      videos: [{ url: 'https://x/a.mp4' }, { url: 'https://x/b.mp4' }],
      seed: 7,
    })
    expect((capped.videos as unknown[]).length).toBe(1)
  })
})

describe('vendor documents', () => {
  it('picks image candidates from either envelope and rejects empty ones', () => {
    expect(pickImageCandidate({ data: [{ b64_json: 'AA' }] })).toEqual({ kind: 'base64', data: 'AA' })
    expect(pickImageCandidate({ images: [{ url: 'https://x/y.png' }] })).toEqual({ kind: 'url', url: 'https://x/y.png' })
    expect(pickImageCandidate({ data: [{ b64_json: 'AA', url: 'https://x/y.png' }] })).toEqual({ kind: 'base64', data: 'AA' })
    expect(pickImageCandidate({ data: [{ b64_json: '' }] })).toBeUndefined()
    expect(pickImageCandidate({ data: [] })).toBeUndefined()
    expect(pickImageCandidate(undefined)).toBeUndefined()
    expect(pickImageCandidate('text')).toBeUndefined()
  })

  it('finds a video url across the field names the vendors use', () => {
    expect(pickVideoUrl({ data: [{ url: 'a' }] })).toBe('a')
    expect(pickVideoUrl({ data: [{ video_url: 'b' }] })).toBe('b')
    expect(pickVideoUrl({ data: { url: 'c' } })).toBe('c')
    expect(pickVideoUrl({ data: { video_url: 'd' } })).toBe('d')
    expect(pickVideoUrl({ output: ['https://e'] })).toBe('https://e')
    expect(pickVideoUrl({ output: [{ url: 'f' }] })).toBe('f')
    expect(pickVideoUrl({ url: 'g' })).toBe('g')
    expect(pickVideoUrl({ metadata: { url: 'h' } })).toBe('h')
    expect(pickVideoUrl({ data: [{}], output: [42], url: '' })).toBe('')
    expect(pickVideoUrl(undefined)).toBe('')
    expect(pickVideoUrl({ output: ['file:///local'] })).toBe('')
  })

  it('finds job ids and reported size lists', () => {
    expect(pickTaskId({ data: [{ id: 'x' }] })).toBe('x')
    expect(pickTaskId({ data: { id: 'y' } })).toBe('y')
    expect(pickTaskId({ data: {} })).toBe('')
    expect(pickTaskId(undefined)).toBe('')
    expect(pickVideoId({ video_id: 'v' })).toBe('v')
    expect(pickVideoId({ data: { id: 'fallback' } })).toBe('fallback')
    expect(pickVideoId({})).toBe('')
    expect(validSizesOf({ data: { valid_sizes: ['720P', 1] } })).toEqual(['720P'])
    expect(validSizesOf({ data: {} })).toEqual([])
    expect(validSizesOf(undefined)).toEqual([])
  })

  it('chooses the closest size by pixel height', () => {
    expect(bestSizeFor('1080P', ['720P', '1080P', '2K'])).toBe('1080P')
    expect(bestSizeFor('1080P', ['480P', '720P'])).toBe('720P')
    expect(bestSizeFor('720P', ['1080P', '2K'])).toBe('1080P')
    expect(bestSizeFor('1080P', ['1024x1024', '1920x1080'])).toBe('1920x1080')
    expect(bestSizeFor('1080P', ['unknown'])).toBe('')
    expect(bestSizeFor('1080P', [])).toBe('')
    expect(bestSizeFor('1080P', ['1080P', '720P'])).toBe('1080P')
    expect(bestSizeFor('720P', ['1080P', '2K'])).toBe('1080P')
  })

  it('reports sizes the request will use', () => {
    expect(imageSizeOf(agnes, { provider: 'p', model: 'm', prompt: 'x', resolution: '2K' })).toBe('2K')
    expect(imageSizeOf(agnes, { provider: 'p', model: 'm', prompt: 'x', resolution: '720p' })).toBe('1K')
    expect(imageSizeOf(agnes, { provider: 'p', model: 'm', prompt: 'x', preferredSize: '3k' })).toBe('3K')
    expect(imageSizeOf(openai, { provider: 'p', model: 'm', prompt: 'x', resolution: '512x512' })).toBe('512x512')
    expect(imageSizeOf(openai, { provider: 'p', model: 'm', prompt: 'x' })).toBe('1024x1024')
    expect(imageSizeOf(openai, { provider: 'p', model: 'm', prompt: 'x', preferredSize: '256x256' })).toBe('256x256')
  })

  it('builds image bodies per dialect', () => {
    expect(imageBody(agnes, { provider: 'p', model: 'm', prompt: 'x', resolution: '720p', aspectRatio: '3:4' }))
      .toEqual({ model: 'm', prompt: 'x', n: 1, size: '1K', ratio: '3:4', extra_body: { response_format: 'url' } })
    expect(imageBody(openai, { provider: 'p', model: 'm', prompt: 'x' }))
      .toEqual({ model: 'm', prompt: 'x', n: 1, size: '1024x1024' })
  })

  it('builds video bodies per dialect', () => {
    expect(videoBody(agnes, { provider: 'p', model: 'm', prompt: 'x', durationSeconds: 30, resolution: '1080p', aspectRatio: '16:9' }, '1080P'))
      .toEqual({ model: 'm', prompt: 'x', seconds: '12', size: '1080P', aspect_ratio: '16:9', mode: 'text' })
    expect(videoBody(openai, { provider: 'p', model: 'm', prompt: 'x', durationSeconds: 0.4 }, '720p'))
      .toEqual({ model: 'm', prompt: 'x', duration: 1, resolution: '720p', aspect_ratio: '9:16' })
    expect(videoBody(openai, { provider: 'p', model: 'm', prompt: 'x', durationSeconds: 5, aspectRatio: '1:1', images: ['a', 'b'] }, '1080p'))
      .toEqual({ model: 'm', prompt: 'x', duration: 5, resolution: '1080p', aspect_ratio: '1:1', image: 'a', images: ['a', 'b'] })
  })

  it('reports the size a submission starts with', () => {
    expect(firstVideoSize(agnes, { provider: 'p', model: 'agnes-video-2.5-flash', prompt: 'x', durationSeconds: 5, resolution: '1080p' })).toBe('720P')
    expect(firstVideoSize(agnes, { provider: 'p', model: 'm', prompt: 'x', durationSeconds: 5, preferredSize: '1K' })).toBe('1K')
    expect(firstVideoSize(openai, { provider: 'p', model: 'm', prompt: 'x', durationSeconds: 5 })).toBe('720p')
    expect(firstVideoSize(openai, { provider: 'p', model: 'm', prompt: 'x', durationSeconds: 5, resolution: '1080p' })).toBe('1080p')
  })

  it('collapses a vendor body into a one-line excerpt', () => {
    expect(excerpt('  a\n\tb  ')).toBe('a b')
    expect(excerpt('x'.repeat(500))).toHaveLength(200)
  })
})
