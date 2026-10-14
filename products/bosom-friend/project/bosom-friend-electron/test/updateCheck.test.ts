import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 桌面壳的更新检查是 CJS（Electron 主进程加载），这里用 createRequire 引进来：
// 纯逻辑必须能单独测，不能只靠"装起来点一下"。
const require = createRequire(import.meta.url)
// 用绝对路径：这个套件跑在 electron 工程下，相对路径的解析基准容易被 runner 改掉。
const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'desktop', 'electron', 'update-check.cjs')
const { compareVersions, parseVersion, checkForUpdate } = require(CHECKER) as {
  compareVersions: (a: unknown, b: unknown) => number
  parseVersion: (text: unknown) => { major: number, minor: number, patch: number, prerelease: string } | null
  checkForUpdate: (options: { currentVersion: string, manifestUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number }) => Promise<{
    update: boolean
    currentVersion: string
    newVersion?: string
    url?: string
    force?: boolean
    reason: string
    message?: string
  }>
}

/** 造一个只回一次响应的 fetch 桩。 */
function fetchOnce(payload: unknown, init: { status?: number, throws?: string } = {}): typeof fetch {
  return (async () => {
    if (init.throws !== undefined) throw new Error(init.throws)
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status: init.status ?? 200 })
  }) as unknown as typeof fetch
}

describe('版本比较：三段数字 + 预发布标签', () => {
  it('数字逐段比较', () => {
    expect(compareVersions('0.2.60', '0.2.59')).toBe(1)
    expect(compareVersions('0.2.59', '0.2.60')).toBe(-1)
    expect(compareVersions('0.2.59', '0.2.59')).toBe(0)
    expect(compareVersions('0.3.0', '0.2.99')).toBe(1)
  })

  it('带 v 前缀与预发布标签都能解析', () => {
    expect(parseVersion('v0.2.59')).toEqual({ major: 0, minor: 2, patch: 59, prerelease: '' })
    expect(parseVersion('0.2.59-rc.1')?.prerelease).toBe('rc.1')
    expect(parseVersion('乱七八糟')).toBeNull()
  })

  it('预发布版小于同号正式版：发布候选不能顶掉已发的版本', () => {
    expect(compareVersions('0.2.59-rc.1', '0.2.59')).toBe(-1)
    expect(compareVersions('0.2.59', '0.2.59-rc.1')).toBe(1)
  })

  it('解析不了时判"相等"：宁可说没有更新，也不误报有更新', () => {
    expect(compareVersions('abc', '0.2.59')).toBe(0)
    expect(compareVersions('0.2.59', '')).toBe(0)
  })
})

describe('更新检查：只发现新版本并给出下载地址', () => {
  it('清单版本更高时回报可更新 + 下载地址 + 说明', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.2.59',
      manifestUrl: 'https://example.com/version.json',
      fetchImpl: fetchOnce({ version: '0.2.60', url: 'https://example.com/setup.exe', notes: '修了两个缺陷' }),
    })
    expect(result.update).toBe(true)
    expect(result.newVersion).toBe('0.2.60')
    expect(result.url).toBe('https://example.com/setup.exe')
    expect(result.reason).toBe('update-available')
  })

  it('清单里的最低版本高于本地时标为必须更新', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.2.50',
      manifestUrl: 'https://example.com/version.json',
      fetchImpl: fetchOnce({ version: '0.2.60', url: 'https://example.com/setup.exe', minimum: '0.2.55' }),
    })
    expect(result.update).toBe(true)
    expect(result.force).toBe(true)
  })

  it('版本相同报"已是最新"', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.2.59',
      manifestUrl: 'https://example.com/version.json',
      fetchImpl: fetchOnce({ version: '0.2.59', url: 'https://example.com/setup.exe' }),
    })
    expect(result.update).toBe(false)
    expect(result.reason).toBe('up-to-date')
  })

  it('本地比清单还新时如实说明，不谎称有更新', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.2.61',
      manifestUrl: 'https://example.com/version.json',
      fetchImpl: fetchOnce({ version: '0.2.60' }),
    })
    expect(result.update).toBe(false)
    expect(result.reason).toBe('ahead')
    expect(result.message).toContain('未发布')
  })

  it('网络不可达 / HTTP 非 2xx / JSON 不合法 / 缺版本号 都如实报错，不假装最新', async () => {
    const cases = [
      fetchOnce(null, { throws: 'boom' }),
      fetchOnce('{}', { status: 500 }),
      fetchOnce('not-json'),
      fetchOnce({ url: 'https://example.com/setup.exe' }),
    ]
    for (const impl of cases) {
      const result = await checkForUpdate({ currentVersion: '0.2.59', manifestUrl: 'https://example.com/version.json', fetchImpl: impl })
      expect(result.update).toBe(false)
      expect(result.reason).toBe('error')
      expect(result.message).toBeTruthy()
    }
  })

  it('没配地址时不发请求，直接如实报错', async () => {
    let called = 0
    const impl = (async () => { called += 1; return new Response('{}') }) as unknown as typeof fetch
    const result = await checkForUpdate({ currentVersion: '0.2.59', manifestUrl: '', fetchImpl: impl })
    expect(called).toBe(0)
    expect(result.reason).toBe('error')
  })
})
