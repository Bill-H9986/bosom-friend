import { describe, expect, it } from 'vitest'
import {
  describeMediaFailure,
  isRetryableMediaFailure,
  isUnreachableMediaFailure,
  mediaFailureStatus,
} from '../src/media-gateway.ts'

/**
 * 一个进程里可以同时存在 \`@deepseek-ai/dsh-media\` 的**两份物理副本**（pnpm 按依赖方的 peer 集合
 * 各注入一份）：提供方那份抛出的错误不是产品 import 的那个类的实例。原先这里用 \`instanceof MediaError\`，
 * 于是厂商的 429/503 全被判成"未知错误"——不重试、读不到状态码、失败原因丢掉「[可重试]」前缀，
 * 一条已经跑成十镜的长视频被一次瞬时厂商 503 判死（DEF-169，2026-09-23 真机对账实测）。
 *
 * 这份用例把"另一份副本的错误"按结构造出来（类不同、字段相同、标记是同一个 \`Symbol.for\`），
 * 并断言分类结果与"本副本的 MediaError"一致——判据跨副本成立，才谈得上自动重试。
 */
function foreignMediaError(code: string, status?: number): Error {
  return Object.assign(new Error('media-pi-ai: video submission was rejected with HTTP ' + String(status)), {
    name: 'MediaError',
    code,
    ...(status === undefined ? {} : { status }),
    [Symbol.for('@deepseek-ai/dsh-media/MediaError')]: true,
  })
}

describe('媒体失败分类跨模块副本成立（DEF-169）', () => {
  it('厂商 429 / 5xx 判成可重试：限流与网关抖动不该让整条任务作废', () => {
    expect(isRetryableMediaFailure(foreignMediaError('MEDIA_VENDOR_REJECTED', 429))).toBe(true)
    expect(isRetryableMediaFailure(foreignMediaError('MEDIA_VENDOR_REJECTED', 503))).toBe(true)
  })

  it('厂商明确拒收（4xx）不重试：重试只是白花额度', () => {
    expect(isRetryableMediaFailure(foreignMediaError('MEDIA_VENDOR_REJECTED', 400))).toBe(false)
    expect(isRetryableMediaFailure(foreignMediaError('MEDIA_VENDOR_REJECTED', 401))).toBe(false)
  })

  it('状态码读得出来：重试判断与用户文案都靠它', () => {
    expect(mediaFailureStatus(foreignMediaError('MEDIA_VENDOR_REJECTED', 503))).toBe(503)
    expect(describeMediaFailure(foreignMediaError('MEDIA_VENDOR_REJECTED', 503), 'video')).toContain('HTTP 503')
  })

  it('完全没有应答判成连接失败（另一条可重试路径）', () => {
    expect(isUnreachableMediaFailure(foreignMediaError('MEDIA_VENDOR_UNREACHABLE'))).toBe(true)
    expect(describeMediaFailure(foreignMediaError('MEDIA_VENDOR_UNREACHABLE'), 'video')).toContain('厂商无响应')
  })

  it('不是媒体错误的不冒充：原因如实带上原文', () => {
    expect(isRetryableMediaFailure(new Error('boom'))).toBe(false)
    expect(mediaFailureStatus(new Error('boom'))).toBeUndefined()
    expect(describeMediaFailure(new Error('boom'), 'video')).toContain('boom')
  })
})
