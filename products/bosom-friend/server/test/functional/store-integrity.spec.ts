import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../src/store.ts'

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

  it('另一个实例写入后本实例读得到新值（磁盘是唯一事实源）', () => {
    const root = makeRoot()
    const first = openStore(root)
    const second = openStore(root)
    first.files.accounts.save([{ id: 'acc-a' } as never])
    expect(second.files.accounts.load()).toEqual([{ id: 'acc-a' }])
    second.files.accounts.save([{ id: 'acc-b' } as never])
    expect(first.files.accounts.load()).toEqual([{ id: 'acc-b' }])
  })
})
