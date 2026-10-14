import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore, writeDataJson } from '../../src/store.ts'

/**
 * G3 的两条存储契约：
 *  1. schemaVersion 必须有**升级路径**——低版本逐级迁移，降级安装（文件比程序新）抛错，
 *     绝不能"按空态重建"（那会让用户看到一夜之间变空的库）；
 *  2. 一次请求里的多处改动必须**要么全成要么全不成**——提交阶段任一步失败整体回滚。
 */
const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bf-store-tx-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('schemaVersion 迁移链', () => {
  it('平铺旧格式（版本 0）按迁移链升到当前版本读出内容', () => {
    const root = makeRoot()
    const file = join(root, 'accounts.json')
    writeFileSync(file, JSON.stringify([{ id: 'acc-legacy' }], null, 2), 'utf8')
    const store = openStore(root)
    expect(store.files.accounts.load()).toEqual([{ id: 'acc-legacy' }])
  })

  it('文件版本比程序新时抛错，且不改动文件（降级安装不得清空数据）', () => {
    const root = makeRoot()
    const file = join(root, 'accounts.json')
    const future = JSON.stringify({ schemaVersion: 99, value: [{ id: 'acc-future' }] }, null, 2)
    writeFileSync(file, future, 'utf8')
    const store = openStore(root)
    expect(() => store.files.accounts.load()).toThrow(/版本比本程序新/)
    expect(readFileSync(file, 'utf8')).toBe(future)
  })
})

describe('批量事务', () => {
  it('事务体抛错时一个文件都没写（全不成）', () => {
    const root = makeRoot()
    const store = openStore(root)
    store.files.accounts.save([{ id: 'acc-1' } as never])
    const before = readFileSync(join(root, 'accounts.json'), 'utf8')

    expect(() => store.transact(() => {
      store.files.accounts.save([{ id: 'acc-2' } as never])
      store.files.metrics.save([{ id: 'm-1' } as never])
      throw new Error('业务校验失败')
    })).toThrow(/业务校验失败/)

    expect(readFileSync(join(root, 'accounts.json'), 'utf8')).toBe(before)
    expect(store.files.accounts.load()).toEqual([{ id: 'acc-1' }])
  })

  it('提交阶段失败时已写的文件回滚到写入前（要么全成要么全不成）', () => {
    const root = makeRoot()
    const store = openStore(root)
    store.files.accounts.save([{ id: 'acc-1' } as never])
    store.files.metrics.save([{ id: 'm-1' } as never])
    const accountsBefore = readFileSync(join(root, 'accounts.json'), 'utf8')
    // 让 metrics 的磁盘内容在本实例读过之后被"另一个写入方"改掉：提交时会触发丢失更新守卫。
    store.files.accounts.load()
    store.files.metrics.load()
    writeFileSync(join(root, 'metrics.json'), JSON.stringify({ schemaVersion: 1, value: [{ id: 'm-other' }] }, null, 2) + '\n', 'utf8')

    expect(() => store.transact(() => {
      store.files.accounts.save([{ id: 'acc-1' } as never, { id: 'acc-2' } as never])
      store.files.metrics.save([{ id: 'm-1' } as never, { id: 'm-2' } as never])
    })).toThrow(/批量写入没有全部生效/)

    // accounts 先提交过，必须被回滚成原内容
    expect(readFileSync(join(root, 'accounts.json'), 'utf8')).toBe(accountsBefore)
  })

  it('事务成功时两个文件都落盘，且事务内读得到暂存值', () => {
    const root = makeRoot()
    const store = openStore(root)
    store.transact(() => {
      store.files.accounts.save([{ id: 'acc-1' } as never])
      store.files.metrics.save([{ id: 'm-1' } as never])
      expect(store.files.accounts.load()).toEqual([{ id: 'acc-1' }])
    })
    expect(JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')).value).toEqual([{ id: 'acc-1' }])
    expect(JSON.parse(readFileSync(join(root, 'metrics.json'), 'utf8')).value).toEqual([{ id: 'm-1' }])
  })

  it('事务不可嵌套', () => {
    const root = makeRoot()
    const store = openStore(root)
    expect(() => store.transact(() => { store.transact(() => {}) })).toThrow(/事务不可嵌套/)
  })
})

describe('数据根原子写原语', () => {
  it('writeDataJson 写出的文件可解析且不含半截内容', () => {
    const root = makeRoot()
    const file = join(root, 'llm-user.json')
    writeDataJson(file, { baseUrl: 'https://example.invalid/v1', model: 'agnes-2.5-flash' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ baseUrl: 'https://example.invalid/v1', model: 'agnes-2.5-flash' })
  })
})
