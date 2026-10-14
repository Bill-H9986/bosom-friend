import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JsonFile } from '../../src/store.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 删掉**最后一个**账号必须成功（DEF-166）。
 *
 * 现场：删除路径用 `files.accounts.save(空数组)` 落盘，而 `save` 有一条空值守卫——「不允许用空数据
 * 覆盖一份非空文件」（防的是「读失败 → 内存空数组 → 回写」那次把 7 个数据文件写成 40 字节空信封的事故）。
 * 于是库里只剩一个账号时，删除请求回 50000「服务端处理失败：拒绝用空数据覆盖已有内容的文件」。
 * 在 E2E 里这表现为**时好时坏**：库里有别的账号时通过、只剩一个时失败——最难查的一种红。
 */

let h: Harness

beforeAll(() => {
  h = createHarness()
})

afterAll(() => {
  h.dispose()
})

/** 建一个服务端账号，返回 id。
 *
 * @param uid - 平台内 uid（每个用例唯一）。
 * @returns 新账号的 id。
 */
async function createAccount(uid: string): Promise<string> {
  const res = await h.call<{ id: string }>('POST', 'v2/channels/accounts', {
    body: { type: 'xhs', uid, nickname: '删最后一个' + uid },
  })
  expect(res.code, String(res.message)).toBe(0)
  return res.data.id
}

/** 读账号文件（落盘的那份）。
 *
 * @returns 账号行数组。
 */
function readAccounts(): Array<{ id: string }> {
  return new JsonFile(h.dataRoot + '/accounts.json', () => [] as Array<{ id: string }>).load()
}

describe('删除账号：删到空也要落盘', () => {
  it('库里只剩一个账号时，删除成功且空列表真的写下去了', async () => {
    const id = await createAccount('delete-last-1')
    expect(readAccounts().length, '前置：库里就这一个账号').toBe(1)

    const res = await h.call('DELETE', 'v2/channels/accounts/' + id, { query: { confirm: '1' } })

    expect(res.code, String(res.message)).toBe(0)
    expect(readAccounts().length, '删完是空列表，不是回滚成原样').toBe(0)
  })

  it('逐个删到空：每一次都成功，顺序不影响结果', async () => {
    const first = await createAccount('delete-last-2a')
    const second = await createAccount('delete-last-2b')

    expect((await h.call('DELETE', 'v2/channels/accounts/' + first, { query: { confirm: '1' } })).code).toBe(0)
    expect(readAccounts().map(a => a.id)).toEqual([second])
    expect((await h.call('DELETE', 'v2/channels/accounts/' + second, { query: { confirm: '1' } })).code).toBe(0)
    expect(readAccounts().length).toBe(0)
  })

  it('负向对照：守卫本身还在——绕过接口用 save 写空数组会被拒绝', () => {
    const probe = new JsonFile(h.dataRoot + '/guard-probe.json', () => [] as string[])
    probe.save(['有内容'])
    expect(() => probe.save([]), '空值覆盖非空文件必须抛错，删除接口才需要显式走 saveEmpty').toThrow(/拒绝用空数据覆盖/)
  })
})
