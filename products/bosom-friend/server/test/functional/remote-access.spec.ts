import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TOKEN_COOKIE,
  findCloudflared,
  hasForwardedOrigin,
  isLocalHostHeader,
  isLoopbackAddress,
  lanUrls,
  newRemoteToken,
  readRemoteAccess,
  remoteTokenMatches,
  writeRemoteAccess,
} from '../../src/remote-access.ts'

/**
 * 远程访问：把"谁算本机、谁能进门"这两条安全判据钉住。
 *
 * 这台机器上装着用户的 API Key 与全部内容，所以这两条判据错了的代价不是"不好用"，
 * 而是"别人能用"。HTTP 网关那一层由真机实测覆盖（换成局域网地址访问，没有令牌必须被挡）。
 */
describe('谁算"本机"', () => {
  it('只认回环：IPv4、IPv6 与 IPv4-mapped 形式', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.1.2.3')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('局域网地址、公网地址、空值都不算本机', () => {
    for (const address of ['192.168.1.5', '10.0.0.7', '172.16.3.9', '::ffff:192.168.1.5', '8.8.8.8', '', undefined])
      expect(isLoopbackAddress(address), String(address) + ' 不该被当成本机').toBe(false)
  })

  it('令牌的三种带法都认，错一个字符就不认', () => {
    const token = 'a'.repeat(64)
    const query = (value: string): URLSearchParams => new URLSearchParams('token=' + value)
    expect(remoteTokenMatches({}, query(token), token), '查询串').toBe(true)
    expect(remoteTokenMatches({ 'x-bf-token': token }, new URLSearchParams(), token), '请求头').toBe(true)
    expect(remoteTokenMatches({ cookie: 'a=1; ' + TOKEN_COOKIE + '=' + token + '; b=2' }, new URLSearchParams(), token), 'Cookie').toBe(true)
    expect(remoteTokenMatches({}, query('a'.repeat(63)), token), '短一位').toBe(false)
    expect(remoteTokenMatches({}, query('b'.repeat(64)), token), '换一个字符').toBe(false)
    expect(remoteTokenMatches({ cookie: TOKEN_COOKIE + '=' + 'b'.repeat(64) }, new URLSearchParams(), token), 'Cookie 不对').toBe(false)
    expect(remoteTokenMatches({}, query(token), ''), '没配令牌时一律不认').toBe(false)
  })
})

describe('隧道转发的回环请求', () => {
  it('带来源头就算远程：隧道进程跑在本机也不能免令牌', () => {
    expect(hasForwardedOrigin({ 'cf-connecting-ip': '1.2.3.4' }), 'cloudflared').toBe(true)
    expect(hasForwardedOrigin({ 'x-forwarded-for': '1.2.3.4' }), '通用反向代理').toBe(true)
    expect(hasForwardedOrigin({ 'x-real-ip': '1.2.3.4' })).toBe(true)
    expect(hasForwardedOrigin({ forwarded: 'for=1.2.3.4' })).toBe(true)
    expect(hasForwardedOrigin({ 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'] }), '多级代理').toBe(true)
    expect(hasForwardedOrigin({}), '本机浏览器不带这些头').toBe(false)
    expect(hasForwardedOrigin({ 'x-forwarded-for': '' }), '空值不算').toBe(false)
  })

  it('Host 只认本机写法，公网域名一律按远程处理', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:31280', 'localhost', 'localhost:31280', '::1', '[::1]:31280', undefined, ''])
      expect(isLocalHostHeader(host), String(host) + ' 应算本机').toBe(true)
    for (const host of ['xxx.trycloudflare.com', 'abc.ngrok.io', '192.168.1.100:31280'])
      expect(isLocalHostHeader(host), String(host) + ' 应算远程').toBe(false)
  })
})

describe('配置落盘', () => {
  it('没配过时：默认关闭 + 自动生成一个 64 位十六进制令牌', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-remote-'))
    try {
      const cfg = readRemoteAccess(dir)
      expect(cfg.enabled, '默认必须关着').toBe(false)
      expect(cfg.bindAll).toBe(false)
      expect(cfg.tunnelCommand).toBe('')
      expect(cfg.token).toMatch(/^[0-9a-f]{64}$/)
      expect(newRemoteToken()).not.toBe(newRemoteToken())
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('写下去能原样读回来；损坏的文件按默认值运行而不是崩掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-remote-'))
    try {
      const token = newRemoteToken()
      writeRemoteAccess(dir, { enabled: true, token, bindAll: true, tunnelCommand: 'ngrok http {port}' })
      const back = readRemoteAccess(dir)
      expect(back).toEqual({ enabled: true, token, bindAll: true, tunnelCommand: 'ngrok http {port}' })

      writeFileSync(join(dir, 'remote-access.json'), '{ 坏掉的 json', 'utf8')
      const fallback = readRemoteAccess(dir)
      expect(fallback.enabled, '读坏了按默认（关闭）').toBe(false)
      expect(readFileSync(join(dir, 'remote-access.json'), 'utf8'), '坏文件不改写，留给用户看').toContain('坏掉的 json')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('局域网地址', () => {
  it('列出非回环 IPv4，拼接成可直接打开的地址；没有网卡时为空数组', () => {
    const urls = lanUrls(31280)
    for (const url of urls) {
      expect(url).toMatch(/^http:\/\/(\d+\.){3}\d+:31280\/bosom-friend\/$/)
      expect(url).not.toContain('127.')
    }
    expect(new Set(urls).size, '多网卡去重').toBe(urls.length)
    expect(Array.isArray(lanUrls(0))).toBe(true)
  })
})

describe('隧道可执行文件探测', () => {
  it('找不到就返回空串（不猜、不假装）', () => {
    const found = findCloudflared()
    expect(typeof found).toBe('string')
    if (found !== '') expect(found.toLowerCase()).toContain('cloudflared')
  })
})
