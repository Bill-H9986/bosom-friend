/**
 * 远程访问：把这台机器当成服务器，让手机或别的电脑也能用这个 App。
 *
 * 三件事拆开看，各自的"怎么才生效"不一样：
 *
 * 1. **访问令牌**（随时生效）：远程访问一开，**非回环**请求必须带令牌。本机（127.0.0.1）
 *    不受影响——坐在同一台电脑前的人不需要令牌。令牌 32 字节随机、可一键轮换。
 * 2. **局域网可达**（要重启）：让同网段的设备连上，官方 Web 服务必须监听 `0.0.0.0`，
 *    而监听地址是在**启动时**定的，所以这个开关保存后要重启运行时（界面会如实说明）。
 * 3. **外网可达**（随时生效）：最现实的做法是隧道——在本机起一个进程（cloudflared / ngrok /
 *    frp / ssh -R 都行），它连回本机的回环端口，再给出一个公网地址。隧道进程随 App 一起退出。
 *
 * 默认全关：这台机器上装着用户的 API Key 与全部内容，默认不对外暴露是唯一安全的默认值。
 * @module @deepseek-ai/dsh-bosom-friend-server/remote-access
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tokenEquals } from './http.ts'
import { writeDataJson } from './store.ts'
import { trackChild } from './platform-processes.ts'

/** 落盘的远程访问配置。 */
export interface RemoteAccessConfig {
  /** 总开关：关着时非回环请求一律拒绝（连令牌都不必看）。 */
  enabled: boolean
  /** 访问令牌：远程请求凭它进门（本机不需要）。 */
  token: string
  /** 监听全部网卡（局域网可达）；需要重启运行时才生效。 */
  bindAll: boolean
  /** 自定义隧道命令；留空时自动探测 cloudflared。`{port}` 会被替换成实际端口。 */
  tunnelCommand: string
}

/** 配置文件名（数据根下）。 */
const FILE = 'remote-access.json'

/**
 * 生成一个新令牌。
 *
 * @returns 32 字节随机数的十六进制串（64 字符）。
 */
export function newRemoteToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 读配置；文件不存在或损坏时返回默认值（默认关闭 + 一个新令牌）。
 *
 * 损坏时**不覆盖原文件**：那是一份用户看不见的配置，写坏了更难查；这里只按默认值运行。
 *
 * @param dataRoot - 产品数据根。
 * @returns 当前配置（缺字段按默认补齐）。
 */
export function readRemoteAccess(dataRoot: string): RemoteAccessConfig {
  const fallback: RemoteAccessConfig = { enabled: false, token: newRemoteToken(), bindAll: false, tunnelCommand: '' }
  try {
    const raw = JSON.parse(readFileSync(join(dataRoot, FILE), 'utf8')) as Partial<RemoteAccessConfig>
    return {
      enabled: raw.enabled === true,
      token: typeof raw.token === 'string' && raw.token.length >= 16 ? raw.token : fallback.token,
      bindAll: raw.bindAll === true,
      tunnelCommand: typeof raw.tunnelCommand === 'string' ? raw.tunnelCommand : '',
    }
  }
  catch {
    return fallback
  }
}

/**
 * 写配置（整份覆盖）。
 *
 * @param dataRoot - 产品数据根。
 * @param config - 要落盘的配置。
 */
export function writeRemoteAccess(dataRoot: string, config: RemoteAccessConfig): void {
  writeDataJson(join(dataRoot, FILE), config)
}

/**
 * 这个地址是不是本机。
 *
 * 只认回环：`127.0.0.0/8`、`::1`，以及 IPv4-mapped 形式 `::ffff:127.x.x.x`。
 * 局域网地址（192.168.x.x 等）**不算本机**——那正是要凭令牌进门的一类。
 *
 * @param address - socket 的 remoteAddress（可能缺省）。
 * @returns true 表示来自本机。
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address === '') return false
  const value = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (value === '::1') return true
  return /^127\./.test(value)
}

/**
 * 隧道/反向代理在本机转发时写下的来源头。
 *
 * 本机浏览器直接打开页面不会带这些头，它们只在有代理站在中间时出现。因此它们出现的
 * 唯一合理解释是**请求从机器之外来、被隧道进程转发到了回环端口**；那种请求必须凭
 * 令牌进门，不能因为隧道进程恰好也跑在本机就被当成「坐在电脑前的人」。
 */
const FORWARDED_ORIGIN_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded'] as const

/**
 * 这次请求是否带着隧道/代理留下的来源头。
 *
 * @param headers - 请求头。
 * @returns true 表示请求由本机的隧道或反向代理转发而来。
 */
export function hasForwardedOrigin(headers: Record<string, string | string[] | undefined>): boolean {
  return FORWARDED_ORIGIN_HEADERS.some((name) => {
    const value = headers[name]
    const text = Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
    return text !== ''
  })
}

/**
 * Host 头是不是本机地址。
 *
 * 本机页面只会用 `127.0.0.1` / `localhost` / `::1` 打开；隧道转发过来的请求带的是
 * 公网域名（形如 `xxx.trycloudflare.com`）。拿不到 Host 时按本机处理：宁可不收紧，
 * 也不要把官方 Web Worker 那种没有网络对端的进程内通道挡在门外。
 *
 * @param host - 请求的 Host 头。
 * @returns true 表示 Host 指向本机。
 */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (host === undefined || host === '') return true
  // IPv6 字面量先摘出来：裸 `::1` 用冒号切分会得到空串，方括号形式要连括号一起认。
  const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host
  if (bare === '::1' || bare === '[::1]') return true
  const name = bare.split(':')[0] ?? ''
  return name === 'localhost' || /^127\./.test(name)
}

/**
 * 这次请求带的令牌对不对（三种带法任选：查询串、请求头、Cookie）。
 *
 * Cookie 是给浏览器用的：第一次用 `?token=xxx` 打开页面时写下它，之后同源的
 * XHR / `<img>` / `<video>` 都会自动带上，用户不必在每个地址后面粘令牌。
 *
 * @param headers - 请求头。
 * @param query - 查询串。
 * @param expected - 当前令牌。
 * @returns true 表示令牌有效。
 */
export function remoteTokenMatches(
  headers: Record<string, string | string[] | undefined>,
  query: URLSearchParams,
  expected: string,
): boolean {
  if (expected === '') return false
  const fromQuery = query.get('token') ?? ''
  if (fromQuery !== '' && tokenEquals(fromQuery, expected)) return true
  const header = headers['x-bf-token']
  const fromHeader = Array.isArray(header) ? (header[0] ?? '') : (header ?? '')
  if (fromHeader !== '' && tokenEquals(fromHeader, expected)) return true
  const cookie = headers.cookie
  const raw = Array.isArray(cookie) ? (cookie[0] ?? '') : (cookie ?? '')
  return raw.split(';').some((part) => {
    const [name, ...rest] = part.trim().split('=')
    return name === TOKEN_COOKIE && tokenEquals(rest.join('='), expected)
  })
}

/** 令牌 Cookie 名。 */
export const TOKEN_COOKIE = 'bf_remote_token'

/**
 * 本机的局域网地址（IPv4、非回环），远程访问时给用户照着填/扫码。
 *
 * 一台机器可能有多张网卡（有线 + 无线 + 虚拟网卡）：全部列出，让用户自己认。
 *
 * @param port - 服务端口。
 * @returns 可直接打开的地址列表（形如 `http://192.168.1.5:31280/bosom-friend/`）。
 */
export function lanUrls(port: number): string[] {
  const urls: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      urls.push('http://' + item.address + ':' + String(port) + '/bosom-friend/')
    }
  }
  return [...new Set(urls)]
}

/** 隧道的运行状态。 */
export interface TunnelStatus {
  running: boolean
  /** 拿到的公网地址；还没解析出来时为空串。 */
  url: string
  /** 用的什么（内置探测到的 cloudflared / 用户自己的命令）。 */
  provider: string
  /** 启动失败或进程退出时的原因。 */
  error: string
  /** 最近的输出行（用户自己的隧道我们解析不出地址时，让他直接看这里）。 */
  log: string[]
}

/** 当前隧道进程（一个进程即一条隧道）。 */
let tunnel: { child: ChildProcess, provider: string, url: string, error: string, log: string[] } | null = null

/** 从一行输出里抠出公网地址：优先 trycloudflare，其次任意 https 地址。 */
function extractUrl(line: string): string {
  const quick = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line)
  if (quick !== null) return quick[0]
  const any = /https:\/\/[^\s"'|]+/i.exec(line)
  return any === null ? '' : any[0]
}

/**
 * 找本机的 cloudflared：先看 PATH，再看几个常见的安装位置。
 *
 * @returns 可执行文件路径；找不到时为空串。
 */
export function findCloudflared(): string {
  const fromPath = spawnSync('where', ['cloudflared'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  if (fromPath.status === 0) {
    const first = String(fromPath.stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0]
    if (first !== undefined && first !== '') return first
  }
  const candidates = [
    process.env.LOCALAPPDATA !== undefined ? join(process.env.LOCALAPPDATA, 'cloudflared', 'cloudflared.exe') : '',
    process.env.ProgramFiles !== undefined ? join(process.env.ProgramFiles, 'cloudflared', 'cloudflared.exe') : '',
    'C:/cloudflared/cloudflared.exe',
  ]
  return candidates.find(item => item !== '' && existsSync(item)) ?? ''
}

/**
 * 起一条隧道：默认用探测到的 cloudflared，用户填了命令就用他的（`{port}` 会替换）。
 *
 * 进程登记在 {@link trackChild} 上：App 退出时整棵树一起收，不留孤儿进程。
 * 地址从输出里解析——解析不出来**不报假成功**，状态里如实写"已启动但没解析出地址"。
 *
 * @param input.dataRoot - 产品数据根（放临时下载/日志用）。
 * @param input.port - 本机服务端口。
 * @param input.command - 自定义命令；留空时用 cloudflared。
 * @returns 启动结果；失败给可读原因。
 */
export function startTunnel(input: { port: number, command: string }): { ok: true } | { ok: false, error: string } {
  if (tunnel !== null) return { ok: false, error: '已经有一条隧道在跑了，先停掉再开' }
  const custom = input.command.trim()
  const detected = custom === '' ? findCloudflared() : ''
  if (custom === '' && detected === '') {
    return {
      ok: false,
      error: '本机没找到 cloudflared。装一个（https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/）'
        + '或者在下面填自己的隧道命令（ngrok / frp / ssh -R 都行），命令里用 {port} 代表本机端口。',
    }
  }
  const line = custom !== ''
    ? custom.replace(/\{port\}/g, String(input.port))
    : '"' + detected + '" tunnel --url http://127.0.0.1:' + String(input.port) + ' --no-autoupdate'
  const child = trackChild(spawn(line, {
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  const state = { child, provider: custom !== '' ? '自定义命令' : 'cloudflared', url: '', error: '', log: [] as string[] }
  tunnel = state
  const onData = (chunk: unknown): void => {
    const text = String(chunk)
    for (const raw of text.split(/\r?\n/)) {
      const item = raw.trim()
      if (item === '') continue
      state.log = [...state.log.slice(-19), item]
      if (state.url === '') {
        const url = extractUrl(item)
        if (url !== '') state.url = url
      }
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.once('exit', (code) => {
    // 自己退出（隧道断了 / 命令写错了）：如实记原因，别让界面继续显示"运行中"。
    state.error = state.error !== '' ? state.error : '隧道进程已退出（退出码 ' + String(code) + '）'
    if (tunnel === state) tunnel = null
  })
  child.once('error', (error) => {
    state.error = '隧道进程起不来：' + error.message
    if (tunnel === state) tunnel = null
  })
  return { ok: true }
}

/** 停掉当前隧道（没有就什么也不做）。 */
export function stopTunnel(): void {
  const current = tunnel
  tunnel = null
  if (current === null) return
  try { current.child.kill() } catch { /* 已经退出 */ }
}

/**
 * 当前隧道状态。
 *
 * @returns 运行中/地址/用的是哪种/失败原因/最近输出。没在跑时各项为空。
 */
export function tunnelStatus(): TunnelStatus {
  if (tunnel === null) return { running: false, url: '', provider: '', error: '', log: [] }
  return {
    running: tunnel.error === '',
    url: tunnel.url,
    provider: tunnel.provider,
    error: tunnel.error,
    log: tunnel.log,
  }
}
