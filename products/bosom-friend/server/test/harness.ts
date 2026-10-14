import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiAiMediaProvider } from '@deepseek-ai/dsh-media-pi-ai'
import { buildRoutes, kernelRouteId, matchRoute, segsOf } from '../src/api.ts'
import type { Deps, MediaCaller, RouteDef } from '../src/api.ts'
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

/** 一条测试用的媒体路由：id 与用例写进产品配置的那个服务 id 一致（内核路由 id 由 kernelRouteId 推出）。 */
export interface HarnessMediaRoute {
  /** 服务 id（产品设置页里那个 id，例如 `media`）。 */
  readonly providerId: string
  /** 该服务的接口地址，必须与用例写进产品配置的 baseUrl 一致。 */
  readonly baseURL: string
  /** 线上方言；Agnes 形状的厂商桩用 `agnes`（默认 `openai`）。 */
  readonly api?: 'agnes' | 'openai'
}

/** `createHarness` 的可选项。 */
export interface HarnessOptions {
  /**
   * 挂给 `Deps.media` 的媒体路由。
   *
   * 走的是**真实的** Provider（`dsh-media-pi-ai` 的 `createPiAiMediaProvider`），所以用例验的
   * 仍是产品那条链路：产品 → ctx.media → Provider → 厂商。用例把全局 fetch 换成厂商桩即可。
   * 不给就表示这个用例不碰媒体（此时媒体调用会如实报"能力面未挂载"）。
   */
  readonly media?: readonly HarnessMediaRoute[]
}

/**
 * 在进程内挂起产品服务端路由表：临时数据根 + 真实 buildRoutes，不启动 HTTP、不需要内核。
 *
 * @param options - 可选的媒体路由（见 {@link HarnessOptions}）。
 * @returns 路由表、调用器、落盘读取器与卸载函数。
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  // 长视频时长下限（产品默认 90 秒）在功能测试里调小：测试要验的是**同一套编排**，
  // 而不是为了跑得快去放宽产品口径——下限本身就是部署可变量（见 api.ts 的 longVideoMinSeconds）。
  process.env.BF_LONG_VIDEO_MIN_SECONDS = process.env.BF_LONG_VIDEO_MIN_SECONDS ?? '8'
  // 临时目录的布局必须**照抄真实部署**：产品数据根是 `$DSH_HOME/bosom-friend`，
  // 而稳定语境文件与技能目录写在 `$DSH_HOME` 自己那一层（见 agent-context.ts 的 dshHomeOf）。
  //
  // 这里曾经把临时目录直接当数据根，于是 dshHomeOf() 解析成**系统的 %TEMP%**：
  // 所有 spec、所有并行 worker 共用同一个 %TEMP%\skills，任何一个 harness 建路由表时
  // 跑的那次 Curator（账本为空）都会把别的 spec 刚升格的技能归档掉——
  // 表现就是"单文件跑绿、全量跑红"（DEF-145）。顺带还往用户临时目录里留了残渣。
  const home = mkdtempSync(join(tmpdir(), 'bf-fn-'))
  const dataRoot = join(home, 'bosom-friend')
  mkdirSync(dataRoot, { recursive: true })
  const store = openStore(dataRoot)
  const mediaRoutes = options.media
  const media: MediaCaller | undefined = mediaRoutes === undefined
    ? undefined
    : createPiAiMediaProvider({
      config: () => ({
        providers: Object.fromEntries(mediaRoutes.map(route => [
          kernelRouteId(route.providerId),
          {
            baseURL: route.baseURL,
            ...(route.api === undefined ? {} : { api: route.api }),
          },
        ])),
      }),
      // 测试里的密钥由用例自己写进产品配置，能力面这一侧不校验凭据。
      resolveCredential: async () => undefined,
    })
  const deps: Deps = {
    dataRoot,
    store,
    security: {} as Deps['security'],
    kernelAi: false,
    media: () => media,
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
    // 收的是整个 home：数据根之外还有 AGENTS.md 与 skills/，都属于这个 harness 自己挣来的路径。
    dispose: () => rmSync(home, { recursive: true, force: true, maxRetries: 3 }),
  }
}
