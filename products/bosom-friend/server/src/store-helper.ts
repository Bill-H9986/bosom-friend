/**
 * 路由模块共享的小工具（独立于 api.ts，避免运行时循环引用）。
 * @module @deepseek-ai/dsh-bosom-friend-server/store-helper
 */

import type { ServerResponse } from 'node:http'

/** ISO 时间戳。 */
export function nowIso(): string {
  return new Date().toISOString()
}

/** 短随机 id（prefix-xxxxxxxx）。 */
export function uid(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 10)
  return prefix + '-' + rnd
}

/** Java 风格字符串哈希（素材归属校验的 dataId 生成用）。 */
export function hashCode(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0
  return h
}

/** 从请求体读字符串字段。 */
export function readString(body: unknown, key: string, fallback = ''): string {
// oxlint-disable-next-line no-unnecessary-condition -- defensive narrowing at cross-boundary values
  const value = (body as Record<string, unknown>)?.[key]
  return typeof value === 'string' ? value : fallback
}

/** 业务错信封（HTTP 恒 200，业务码承载语义）。 */
export function writeFailRaw(res: ServerResponse, message: string, code: number | string = 500): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ code, data: null, message }))
}
