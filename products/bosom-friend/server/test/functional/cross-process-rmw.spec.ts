import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../src/store.ts'

/**
 * 跨进程读-改-写：服务端与内核是**两个进程**，共用同一数据根。
 * JobQueue.claim/enqueue/fail 全是 load -> mutate -> save，本文件固化该模式的安全语义。
 */
const roots: string[] = []
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bf-rmw-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 })
})

describe('跨进程读-改-写语义', () => {
  it('基于过期快照的写入被拒：不允许静默覆盖对方的改动', () => {
    const root = makeRoot()
    const a = openStore(root)
    const b = openStore(root)
    a.files.jobs.save([{ id: 'seed', status: 'queued' } as never])
    // 两个进程同时读到同一份基线
    const listB = b.files.jobs.load()
    expect(listB.length).toBe(1)
    // A 先追加自己的任务并落盘
    a.files.jobs.save([...a.files.jobs.load(), { id: 'from-a', status: 'queued' } as never])
    // B 基于过期快照追加：必须被拒，而不是静默抹掉 from-a
    expect(() => b.files.jobs.save([...listB, { id: 'from-b', status: 'queued' } as never]))
      .toThrow(/并发写冲突/)
    // A 的改动必须完好保留
    const ids = openStore(root).files.jobs.load().map(j => (j as { id: string }).id)
    expect(ids).toEqual(['seed', 'from-a'])
  })

  it('重新读取后再写可以成功（冲突可恢复）', () => {
    const root = makeRoot()
    const a = openStore(root)
    const b = openStore(root)
    a.files.jobs.save([{ id: 'seed', status: 'queued' } as never])
    void b.files.jobs.load()
    a.files.jobs.save([...a.files.jobs.load(), { id: 'from-a', status: 'queued' } as never])
    // 冲突后重新 load 取得最新基线，再写即成功
    const fresh = b.files.jobs.load()
    b.files.jobs.save([...fresh, { id: 'from-b', status: 'queued' } as never])
    const ids = openStore(root).files.jobs.load().map(j => (j as { id: string }).id)
    expect(ids).toEqual(['seed', 'from-a', 'from-b'])
  })

  it('同一实例连续 save 不受守卫影响', () => {
    const root = makeRoot()
    const a = openStore(root)
    a.files.jobs.save([{ id: 'one' } as never])
    a.files.jobs.save([{ id: 'one' } as never, { id: 'two' } as never])
    a.files.jobs.save([{ id: 'three' } as never])
    expect(openStore(root).files.jobs.load().map(j => (j as { id: string }).id)).toEqual(['three'])
  })
})
