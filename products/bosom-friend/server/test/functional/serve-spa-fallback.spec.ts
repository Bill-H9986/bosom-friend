import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveSpa } from '../../src/http.ts'

/**
 * 静态 SPA 服务：缺失的**资源**请求必须回 404，绝不回退 index.html。
 *
 * 回退曾把 HTML 当 JS 交给浏览器：解析失败抛 SyntaxError，而 Vite 的模块预加载 polyfill
 * 对这类失败不 reject，动态 import 永远挂起，页面停在空白——远程手机上表现为
 * "未知错误 / 对不起，系统出现了错误"。重建产物会删除上一版带哈希的分块，
 * 持有旧 index.html 的浏览器正是踩这一条。
 *
 * 走真实 http 服务而不是桩响应对象：命中文件时 serveSpa 用 createReadStream().pipe(res)，
 * 桩对象不满足可写流契约（pipe 的 onerror 会拿到非 Error），断言就退化成测桩。
 * 端口用 0 由内核分配，符合"每个测试自持端口"的要求。
 */
let dist: string
let server: Server
let base: string

interface Probe { status: number, body: string, contentType: string }

/** 发一次请求并读完响应体。 */
async function get(path: string): Promise<Probe> {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') ?? '' }
}

/**
 * 原样发送请求行。
 *
 * fetch/undici 会在发出前就归一化 `..`，编码形态到不了服务端，遍历防护就测不到；
 * 这里直接写 socket，保证到达 serveSpa 的正是这段原始路径。
 * @param target - 原始请求目标（含未归一化的路径）。
 * @returns 状态码与响应体。
 */
function rawGet(target: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(base).port) })
    let text = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => { socket.write('GET ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n') })
    socket.on('data', chunk => { text += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)
      resolve({ status, body: text, contentType: '' })
    })
  })
}

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'bf-serve-spa-'))
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8')
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)', 'utf8')
  const handler = serveSpa({ dist, backendBaseUrl: '/bosom-friend/api' })
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    handler(url.pathname, res, req)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务未取得端口')
  base = 'http://127.0.0.1:' + String(address.port)
})

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  rmSync(dist, { recursive: true, force: true })
})

describe('缺失资源不回退 index.html', () => {
  it('带扩展名的缺失分块回 404，且响应体不是 HTML', async () => {
    const res = await get('/assets/index-DVENms6T.js')
    expect(res.status).toBe(404)
    expect(res.contentType).toContain('text/plain')
    expect(res.body).not.toContain('<!doctype html>')
    expect(res.body).toContain('asset not found')
  })

  it('缺失的样式与图片同样回 404', async () => {
    expect((await get('/assets/index-C13uKfgE.css')).status).toBe(404)
    expect((await get('/assets/logo-gone.png')).status).toBe(404)
  })

  it('存在的分块仍按原样返回 200', async () => {
    const res = await get('/assets/app-abc123.js')
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/javascript')
    expect(res.body).toContain('console.log(1)')
  })

  it('hash 路由深链（无扩展名）仍回退 index.html', async () => {
    const res = await get('/settings')
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/html')
    expect(res.body).toContain('id="root"')
  })

  it('根路径仍回 index.html', async () => {
    expect((await get('/')).status).toBe(200)
  })

  it('路径遍历仍被拒绝，先于资源判断生效', async () => {
    // 编码形态穿过匹配器后才还原为真实分隔符，防护必须在解码之后成立。
    expect((await rawGet('/%2E%2E%2F%2E%2E%2Fsecret.txt')).status).toBe(403)
  })
})
