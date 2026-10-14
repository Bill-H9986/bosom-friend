import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 素材路径安全：uploads 目录之外的读与写都必须被拒绝。
 *
 * 路由参数在 matchRoute 内经过 decodeURIComponent，`%2E%2E%2F` 到处理器里已是真实
 * 分隔符，所以判定必须发生在解码之后——本测试用编码形态提交正是为了覆盖这一点。
 */
let h: Harness

beforeAll(() => { h = createHarness() })
afterAll(() => { h.dispose() })

describe('素材 id 越界防护', () => {
  it('读接口拒绝编码后的路径遍历，且不泄露文件内容', async () => {
    writeFileSync(join(h.dataRoot, 'secret.txt'), 'TOP-SECRET-PAYLOAD')
    const res = await h.call('GET', 'assets/file/%2E%2E%2Fsecret.txt')
    expect(res.message).toBe('asset not found')
    expect(JSON.stringify(res)).not.toContain('TOP-SECRET-PAYLOAD')
  })

  it('读接口拒绝多级遍历', async () => {
    const res = await h.call('GET', 'assets/file/%2E%2E%2F%2E%2E%2Fsecret.txt')
    expect(res.message).toBe('asset not found')
  })

  it('合法素材仍可写入：确认防护没有误伤正常上传', async () => {
    const ticket = await h.call<{ id: string }>('POST', 'assets/uploadSign', { body: { filename: 'probe.png' } })
    expect(ticket.code).toBe(0)
    const id = ticket.data.id
    await h.call('PUT', 'assets/upload/' + id, { body: Buffer.from('PNG-BYTES') })
    const stored = join(h.dataRoot, 'uploads', id)
    expect(existsSync(stored)).toBe(true)
    expect(readFileSync(stored, 'utf8')).toBe('PNG-BYTES')
  })
})
