/* oxlint-disable no-non-null-assertion, restrict-plus-operands, no-unnecessary-condition, no-unnecessary-type-conversion, no-unnecessary-type-assertion, no-unnecessary-type-parameters, require-await, @stylistic/max-len -- 结构保证型规则：路由段由匹配器确保存在、JSON 文件由 JsonFile 确保可读；中文文案/资源 URL 为长单串，属产品文案而非可拆分语句 */
/**
 * HTTP 助手：信封读写、静态 SPA 服务（含 window.__BACKEND_BASE_URL__ 注入）。
 * Bosom Friend前端 client.ts 以 `{code, data, message}` 判定业务成败（code===0 成功），
 * 本模块是全包唯一允许构造响应信封的出口，保证口径一致。
 * @module @deepseek-ai/dsh-bosom-friend-server/http
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ZyEnvelope } from './types.ts'

/** 静态文件 content-type 表（常用子集）。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
  '.otf': 'font/otf',
}

/**
 * 按扩展名推断 content-type。素材服务与厂商图片内联共用同一张表，
 * 避免两处各写一份、上传的文件在一处能识别、另一处识别不出来。
 *
 * @param ext - 带点扩展名（如 `.png`）；大小写不敏感。
 * @returns 该扩展名的 MIME 类型；未收录时返回 `application/octet-stream`。
 */
export function mimeOfExt(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 写成功信封：code 固定为数字 0（前端 client.ts 与 store/user 均按数字 0 判定）。
 * @param res - 目标响应。
 * @param data - 业务数据载荷。
 */
export function writeOk<T>(res: ServerResponse, data: T): void {
  const body: ZyEnvelope<T> = { code: 0, data, message: 'ok' }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 写失败信封。HTTP 状态沿用语义码；业务码对齐前端已知分支：
 * 认证类用 401/12000（client.ts 静默处理），其余默认 500 触发友好文案。
 * @param res - 目标响应。
 * @param message - 用户可读错误信息。
 * @param code - 业务码，默认 500。
 * @param status - HTTP 状态码，默认 200（Bosom Friend后端为 NestJS 风格，业务错常在 200 内承载）。
 */
export function writeFail(res: ServerResponse, message: string, code: number | string = 500, status = 200): void {
  const body: ZyEnvelope<null> = { code, data: null, message }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 加 CORS 头并短路预检。桌面壳内页面与后端可能不同源；
 * 同源部署时这些头无副作用。
 * @param req - 入站请求。
 * @param res - 目标响应。
 * @returns 是否已作为预检请求结束。
 */
export function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader('access-control-allow-origin', req.headers.origin ?? '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type,authorization,accept-language')
  res.setHeader('access-control-max-age', '86400')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return true
  }
  return false
}

/**
 * 读取请求体；multipart/form-data（上传）原样透传 Buffer 给调用方解析，
 * 其余按 JSON 解析。
 * @param req - 入站请求。
 * @returns 解析后的 JSON 值，或原始 Buffer（multipart），空体为 undefined。
 */
export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => { chunks.push(chunk as Buffer) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const contentType = String(req.headers['content-type'] ?? '')
      if (contentType.includes('multipart/form-data')) {
        resolvePromise(raw)
        return
      }
      if (raw.length === 0) {
        resolvePromise(undefined)
        return
      }
      try {
        resolvePromise(JSON.parse(raw.toString('utf8')) as unknown)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

export interface ServeSpaOptions {
  /** dist 目录绝对路径。 */
  dist: string
  /** 注入 index.html 的运行时后端地址（相对路径=同源）。 */
  backendBaseUrl: string
  /** 注入 index.html 的自动登录 token（等价 Electron 主进程的持久化登录态）。 */
  authToken?: string
  /** 注入 index.html 的当前系统版本号（设置页「系统与更新」底部展示）。 */
  appVersion?: string
  /** 注入 index.html 的性能档位；前端据此关闭重特效（低配机器上粒子与模糊是真实卡顿源）。 */
  perfTier?: string
}

/**
 * SPA 静态服务：命中文件回文件，未命中回 index.html（hash 路由无需 path 匹配）。
 * 返回 index.html 时在首个 script 标签前注入一行运行时配置脚本——这是前端
 * 设计好的后端地址注入口（Electron 由 preload 经 contextBridge 完成同一件事）。
 * @param options - dist 与注入值。
 * @returns 处理函数；入参为剥离挂载前缀后的 URL path 与响应对象。
 */
export function serveSpa(options: ServeSpaOptions) {
  return (urlPath: string, res: ServerResponse, req?: IncomingMessage): void => {
    const clean = decodeURIComponent(urlPath).replace(/^\/+/, '')
    const rel = clean === '' ? 'index.html' : clean
    const target = normalize(resolve(options.dist, rel))
    if (!target.startsWith(normalize(resolve(options.dist)))) {
      res.writeHead(403)
      res.end()
      return
    }
    const isFile = existsSync(target) && statSync(target).isFile()
    const file = isFile ? target : join(options.dist, 'index.html')
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bosom-friend frontend not built: run vite build --mode=test in products/bosom-friend/project/bosom-friend-electron')
      return
    }
    // 根路径直接命中 dist/index.html（isFile=true），回退路径（hash 路由深链）也指向它：
    // 两者都必须注入运行时配置，因此按“服务的是不是 index.html”判定。
    const injected = file === join(options.dist, 'index.html')
    const contentType = mimeOfExt(extname(file))
    const stat = statSync(file)
    const range = req?.headers.range
    if (!injected && range !== undefined && !extname(file).toLowerCase().endsWith('.html')) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      if (match !== null) {
        const start = match[1] !== '' ? Number(match[1]) : 0
        const end = match[2] !== '' ? Number(match[2]) : stat.size - 1
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size && end < stat.size) {
          res.writeHead(206, {
            'content-type': contentType,
            'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${end}/${stat.size}`,
            'content-length': end - start + 1,
            'cache-control': 'public, max-age=3600',
          })
          createReadStream(file, { start, end }).pipe(res)
          return
        }
      }
    }
    const headers: Record<string, string> = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
      ...(extname(file) === '.html'
        ? { 'cache-control': 'no-cache' }
        : { 'cache-control': 'public, max-age=3600' }),
    }
    if (!injected) {
      // 注入运行时配置会改变 HTML 体积，不能使用磁盘原文件长度作为 Content-Length
      headers['content-length'] = String(stat.size)
    }
    res.writeHead(200, headers)
    if (!injected) {
      createReadStream(file).pipe(res)
      return
    }
    const html = readFileSync(file, 'utf8')
    // 浏览器模式桥接垫片：Electron 壳内由 preload 注入 window.ipcRenderer /
    // window.ZhiyinPlugin；纯浏览器托管（本服务的 /bosom-friend/）下 preload 不存在，
    // 前端多处"无守卫"调用（Inform/Update 同步 on、receiveMsg 读取 on 返回值
    // 的 _events[channel] 等）会直接 TypeError。此处注入最小真实实现：
    // on/off 维护 _events 表（bindEventCore 依赖它解构 listener），
    // invoke 恒 null（前端判空），其余方法静默。
    const shim = 'if(!window.ipcRenderer){var __zyIpc={__zyShim:!0,_events:{},'
      + 'on:function(ch,f){var t=this;t._events=t._events||{};var a=t._events[ch]||(t._events[ch]=[]);if(typeof f==="function"){a.push(f)}else{t._events[ch]=f}return t},'
      + 'once:function(ch,f){return this.on(ch,f)},'
      + 'off:function(ch,f){var t=this;if(t._events){var a=t._events[ch];if(typeof f==="function"&&Array.isArray(a)){var i=a.indexOf(f);if(i>=0)a.splice(i,1)}else{delete t._events[ch]}}return t},'
      + 'removeListener:function(ch,f){return this.off(ch,f)},'
      + 'removeAllListeners:function(){this._events={};return this},'
      + 'send:function(){},postMessage:function(){},sendSync:function(){},invoke:function(ch){var c=String(ch||"");if(c.indexOf("INFO")>=0){return Promise.resolve({})}if(c.indexOf("STATISTICS")>=0||c.indexOf("LIST")>=0||c.indexOf("COUNT")>=0){return Promise.resolve([])}return Promise.resolve(null)},'
      + 'getStoreValue:function(k){try{return localStorage.getItem(k)}catch(e){return null}},'
      + 'setStoreValue:function(k,v){try{localStorage.setItem(k,typeof v==="string"?v:JSON.stringify(v))}catch(e){}}};window.ipcRenderer=__zyIpc}'
    const assignments = [
      '__BACKEND_BASE_URL__=' + JSON.stringify(options.backendBaseUrl),
    ]
    if (options.appVersion !== undefined && options.appVersion !== '') {
      assignments.push('__APP_VERSION__=' + JSON.stringify(options.appVersion))
    }
    if (options.authToken !== undefined) {
      assignments.push('__ZHIYIN_AUTH_TOKEN__=' + JSON.stringify(options.authToken))
    }
    if (options.perfTier !== undefined && options.perfTier !== '') {
      assignments.push('__BF_PERF_TIER__=' + JSON.stringify(options.perfTier))
    }
    const boot = '<script>window.' + assignments.join(';window.') + ';' + shim + '</script>'
    const firstScript = html.search(/<script/i)
    const nextHtml = firstScript === -1
      ? html.replace(/<\/head>/i, boot + '</head>')
      : html.slice(0, firstScript) + boot + html.slice(firstScript)
    res.end(nextHtml)
  }
}
