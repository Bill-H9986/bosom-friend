import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../src/store.ts'
import { createHarness } from '../harness.ts'

/**
 * 存储层的真实性契约（要求二 R2 写后回读 / R4 失败即呈现）。
 *
 * 现实触发面：断电或写中断导致 JSON 截断、杀软篡改文件、多个写入者并发覆盖。
 * 旧行为在解析失败时静默按空态返回，下一次 save 会把空态写回，造成不可逆数据丢失
 * （2026-09-09 账号数据事故疑似此路径）。
 */
const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bf-store-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('JsonFile 真实性契约', () => {
  it('损坏文件必须抛错而不是按空态继续，且不得改动损坏现场', () => {
    const root = makeRoot()
    const file = join(root, 'accounts.json')
    const corrupt = '{"schemaVersion":1,"value":[{"id":"acc-1"'
    writeFileSync(file, corrupt, 'utf8')
    const store = openStore(root)
    expect(() => store.files.accounts.load()).toThrow(/数据文件损坏/)
    expect(readFileSync(file, 'utf8')).toBe(corrupt)
  })

  it('保存后落盘内容与本次写入逐字一致（写后回读通过才返回）', () => {
    const root = makeRoot()
    const store = openStore(root)
    store.files.accounts.save([{ id: 'acc-1' } as never])
    const raw = readFileSync(join(root, 'accounts.json'), 'utf8')
    const parsed = JSON.parse(raw) as { schemaVersion: number; value: unknown[] }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.value).toEqual([{ id: 'acc-1' }])
    expect(raw.endsWith('\n')).toBe(true)
  })

  /**
   * BOM 不是损坏：PowerShell 的 `Set-Content`/`Out-File`、记事本另存为"UTF-8"都会写这三个字节。
   * `JSON.parse` 见到它就整份拒绝，于是"内容完全正确、只是多了个头"的文件被当成损坏文件，
   * 整个域读不出数据（2026-09-17：脚本清理素材后 contents.json 带 BOM，素材组接口全线 400）。
   */
  it('带 UTF-8 BOM 的文件按正常内容读取', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'accounts.json'), '\uFEFF' + JSON.stringify({ schemaVersion: 1, value: [{ id: 'acc-bom' }] }), 'utf8')
    expect(openStore(root).files.accounts.load()).toEqual([{ id: 'acc-bom' } as never])
  })

  it('BOM 之后仍是坏 JSON 时照旧抛错（放行 BOM 不等于放行损坏）', () => {
    const root = makeRoot()
    const file = join(root, 'accounts.json')
    writeFileSync(file, '\uFEFF{"schemaVersion":1,"value":[{"id":"acc-1"', 'utf8')
    expect(() => openStore(root).files.accounts.load()).toThrow(/数据文件损坏/)
  })

  it('另一个实例写入后本实例读得到新值（磁盘是唯一事实源）', () => {
    const root = makeRoot()
    const first = openStore(root)
    const second = openStore(root)
    first.files.accounts.save([{ id: 'acc-a' } as never])
    expect(second.files.accounts.load()).toEqual([{ id: 'acc-a' }])
    second.files.accounts.save([{ id: 'acc-b' } as never])
    expect(first.files.accounts.load()).toEqual([{ id: 'acc-b' }])
  })

  /**
   * 交替读写的**压力版**：单次往返碰不出 Windows 的元数据延迟，
   * 而它恰恰是最容易在 CI 上偶发红的那一类（实测修复前 400 次里 329 次读到旧值）。
   */
  it('两实例交替写读 200 轮，一次都不许读到旧值', () => {
    const root = makeRoot()
    const first = openStore(root)
    const second = openStore(root)
    first.files.accounts.save([{ id: 'acc-0000' }] as never)
    for (let i = 1; i <= 200; i += 1) {
      const idA = 'acc-a' + String(i).padStart(4, '0')
      const idB = 'acc-b' + String(i).padStart(4, '0')
      second.files.accounts.save([{ id: idA }] as never)
      expect((first.files.accounts.load() as Array<{ id: string }>)[0]?.id, '第 ' + String(i) + ' 轮 A→B 读到旧值').toBe(idA)
      first.files.accounts.save([{ id: idB }] as never)
      expect((second.files.accounts.load() as Array<{ id: string }>)[0]?.id, '第 ' + String(i) + ' 轮 B→A 读到旧值').toBe(idB)
    }
  })
})

/**
 * 用户可见的一层：数据文件的真实状态必须原样传到接口，不能被"看起来像空数据"悄悄吃掉。
 * 素材组列表是 2026-09-17 那次 BOM 事故的首个受害接口（首页素材组整个读不出来）。
 */
describe('素材组接口的数据文件口径', () => {
  it('contents.json 带 BOM 时素材组照常返回，草稿数照数', async () => {
    const harness = createHarness()
    try {
      writeFileSync(join(harness.dataRoot, 'contents.json'), '\uFEFF' + JSON.stringify({
        schemaVersion: 1,
        value: [{ kind: 'draft', id: 'cnt-bom', _id: 'cnt-bom', groupId: 'mg-persist', title: '带 BOM 的草稿' }],
      }), 'utf8')
      const res = await harness.call<{ list: Array<{ id: string; mediaCount: number }> }>('GET', 'contents/groups/list/1/100')
      expect(res.code).toBe(0)
      expect(res.data.list[0]?.id).toBe('mg-persist')
      expect(res.data.list[0]?.mediaCount, '草稿数不能被 BOM 吃掉').toBe(1)
    }
    finally {
      harness.dispose()
    }
  })

  it('contents.json 真的损坏时接口抛错，不回一个空列表', async () => {
    const harness = createHarness()
    try {
      writeFileSync(join(harness.dataRoot, 'contents.json'), '{"schemaVersion":1,"value":[{"kind":"draft"', 'utf8')
      await expect(harness.call('GET', 'contents/groups/list/1/100')).rejects.toThrow(/数据文件损坏/)
    }
    finally {
      harness.dispose()
    }
  })
})
