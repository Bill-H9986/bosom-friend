import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRoutes, matchRoute, segsOf } from '../src/api.ts'
import type { Deps, RouteDef } from '../src/api.ts'
import { openStore } from '../src/store.ts'

/** SSE 通道上收到的一帧（`data: {...}` 载荷解析结果）。 */
export type SseFrame = Record<string, unknown> & { type?: string }

/** 产品信封：{ code, data, message }。 */
export interface Envelope<T = unknown> {
  code: number
  data: T
  message: string
  /** 响应 HTTP 状态码，便于断言 401/410 这类语义码。 */
  status: number
  /** 本次调用在 SSE 通道写出的帧；非流式接口为空数组。 */
  sse: SseFrame[]
  /** 本次调用写出的响应头（键名小写）：音频流这类非 JSON 响应只能靠它断言。 */
  headers: Record<string, string>
}

/** 一次路由调用的结果与副作用入口。 */
export interface Harness {
  dataRoot: string
  routes: RouteDef[]
  /** 按方法+路径调用路由处理器，拿回解析后的信封。 */
  call: <T = unknown>(method: string, path: string, options?: { body?: unknown; query?: Record<string, string> }) => Promise<Envelope<T>>
  /** 直接读落盘 JSON（自动解 schema 信封）。 */
  disk: <T = unknown>(file: string) => T
  /** 卸载：删掉临时数据根。 */
  dispose: () => void
}

/**
 * 在进程内挂起产品服务端路由表：临时数据根 + 真实 buildRoutes，不启动 HTTP、不需要内核。
 *
 * @returns 路由表、调用器、落盘读取器与卸载函数。
 */
export function createHarness(): Harness {
  const dataRoot = mkdtempSync(join(tmpdir(), 'bf-fn-'))
  const store = openStore(dataRoot)
  const deps: Deps = {
    dataRoot,
    store,
    security: {} as Deps['security'],
    kernelAi: false,
  }
  const routes = buildRoutes(deps)

  const call = async <T = unknown>(method: string, path: string, options: { body?: unknown; query?: Record<string, string> } = {}): Promise<Envelope<T>> => {
    const query = new URLSearchParams(options.query ?? {})
    const match = matchRoute(routes, method, segsOf(path))
    if (match === undefined)
      throw new Error('没有匹配的路由：' + method + ' ' + path)
    let status = 200
    let payload = ''
    const frames: SseFrame[] = []
    const headers: Record<string, string> = {}
    const res = {
      writeHead(code: number, extra?: Record<string, string>) {
        status = code
        Object.assign(headers, extra ?? {})
        return res
      },
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value
      },
      write(chunk: string) {
        // SSE 路由逐帧写 `data: {...}\n\n`；解析出来供断言动作卡有没有发出。
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          try { frames.push(JSON.parse(line.replace(/^data:\s*/, '')) as SseFrame) } catch { /* 心跳等非 JSON 行 */ }
        }
        return true
      },
      end(body?: string) {
        payload = body ?? ''
      },
      on() { return res },
      once() { return res },
      emit() { return true },
      // 音频流路由用 `createReadStream(file).pipe(res)` 落字节；缺了这几个方法
      // Node 会在可读流内部抛 'dest.destroy is not a function'，把用例挂在未捕获异常上。
      destroy() { return res },
      emitClose() { return true },
      writableEnded: true,
      writableFinished: true,
    } as unknown as ServerResponse
    const req = {
      method,
      url: path,
      headers: { 'content-type': 'application/json' },
      on() { return req },
      async *[Symbol.asyncIterator]() { /* 二进制上传路径用不到 */ },
    } as unknown as IncomingMessage
    await match.route.h({ req, res, params: match.params, query, body: options.body })
    const parsed = payload === '' ? { code: -1, data: null, message: '空响应' } : JSON.parse(payload)
    return { ...parsed, status, sse: frames, headers }
  }

  const disk = <T = unknown>(file: string): T => {
    const parsed = JSON.parse(readFileSync(join(dataRoot, file), 'utf8'))
    return (parsed !== null && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed) as T
  }

  return {
    dataRoot,
    routes,
    call,
    disk,
    dispose: () => rmSync(dataRoot, { recursive: true, force: true, maxRetries: 3 }),
  }
}
