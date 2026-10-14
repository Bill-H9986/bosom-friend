import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { JsonFile } from '../../src/store.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import { accountFactKey } from '../../src/types.ts'

/**
 * 账号级 AI 事实只有一个家：**按 (平台, uid) 寻址的事实库**（DEF-147）。
 *
 * 为什么必须这样：账号这个实体在两个地方各有一份——服务端 accounts.json 与**桌面端本机 SQLite**。
 * 事实写在账号行上，桌面端本机账号就没人看得到；写在本机 SQLite 上，服务端语境就读不到
 * （模型永远看不见它）。所以两边唯一共有的标识 (平台, uid) 才是它的地址。
 */

/** 这一轮"模型"回什么。 */
let reply = '给想读书又没时间的上班族：每天一本书的十分钟精读。'

vi.mock('../../src/kernel-client.ts', async () => ({
  ...((({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  )),
  createKernelClient: () => ({
    prompt: async (_prompt: string, onDelta?: (text: string) => void) => {
      if (reply !== '') onDelta?.(reply)
      return { text: reply }
    },
    close: async () => {},
  }),
}))

let h: Harness

beforeAll(async () => {
  h = createHarness()
  await h.call('PUT', 'ai/user-llm', {
    body: {
      providers: [{ id: 'chat', displayName: '对话网关', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat-probe', models: ['chat-probe'] }],
      activeProviderId: 'chat',
    },
  })
})
afterAll(() => {
  h.dispose()
})

/** 建一个服务端账号。 */
async function createAccount(nickname: string, uid: string): Promise<string> {
  const res = await h.call<{ id: string }>('POST', 'v2/channels/accounts', {
    body: { type: 'xhs', uid, nickname },
  })
  expect(res.code, String(res.message)).toBe(0)
  return res.data.id
}

/** 读事实库。 */
function readFacts(): Record<string, { platform: string, uid: string, positioning?: string, risk?: string }> {
  return new JsonFile(h.dataRoot + '/account-facts.json', () => ({})).load()
}

describe('账号动作按 (平台, uid) 也能寻址', () => {
  it('服务端没有这条号的行时，用 platform|uid 照样能写定位', async () => {
    // 模拟桌面端本机账号：服务端**没有**它的行，只有平台与 uid。
    const res = await h.call<{ field: string, value: string }>('POST', 'ai/object-action', {
      body: { kind: 'account', id: 'xhs|local-only-uid', action: 'account-positioning' },
    })
    // 有模型（harness 配了）就应当成功；关键是：**不需要服务端先有账号行**。
    expect(res.code, String(res.message)).toBe(0)
    const facts = readFacts()
    const fact = facts[accountFactKey('xhs', 'local-only-uid')]
    expect(fact, '事实按平台+uid 落库').toBeDefined()
    expect(fact!.uid).toBe('local-only-uid')
    expect(String(fact!.positioning)).not.toBe('')
  })

  it('账号行上的旧值仍读得到，事实库优先（不需要数据迁移）', async () => {
    const id = await createAccount('老数据账号', 'legacy-uid')
    // 直接往账号行上写一个"历史值"（老版本就是这么存的）。
    const rows = new JsonFile<Array<Record<string, unknown>>>(h.dataRoot + '/accounts.json', () => []).load()
    const target = rows.find(row => String(row.id) === id)!
    target.aiPositioning = '老版本写在行上的定位'
    new JsonFile(h.dataRoot + '/accounts.json', () => []).save(rows)

    // 只读时能读到行上的旧值（视图会回落）。
    const before = await h.call<{ list: Array<{ id: string, aiPositioning?: string }> }>('GET', 'v2/channels/accounts')
    expect(before.data.list.find(row => row.id === id)!.aiPositioning).toBe('老版本写在行上的定位')

    // 事实库里有值之后，视图以事实为准。
    const facts = readFacts()
    facts[accountFactKey('xhs', 'legacy-uid')] = { platform: 'xhs', uid: 'legacy-uid', positioning: '新家的定位' }
    new JsonFile(h.dataRoot + '/account-facts.json', () => ({})).save(facts)
    const after = await h.call<{ list: Array<{ id: string, aiPositioning?: string }> }>('GET', 'v2/channels/accounts')
    expect(after.data.list.find(row => row.id === id)!.aiPositioning, '事实库优先').toBe('新家的定位')
  })

  it('写定位不会改动账号行本身（昵称、登录态都不动）', async () => {
    const id = await createAccount('不该被动', 'untouched-uid')
    const before = new JsonFile<Array<Record<string, unknown>>>(h.dataRoot + '/accounts.json', () => []).load()
    const snapshot = JSON.stringify(before.find(row => String(row.id) === id))
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'account', id, action: 'account-positioning' } })
    expect(res.code, String(res.message)).toBe(0)
    const after = new JsonFile<Array<Record<string, unknown>>>(h.dataRoot + '/accounts.json', () => []).load()
    expect(JSON.stringify(after.find(row => String(row.id) === id)), '账号行一个字节都不变').toBe(snapshot)
  })

  it('事实列表接口给界面用（按平台+uid 对账）', async () => {
    const res = await h.call<{ list: Array<{ platform: string, uid: string }> }>('GET', 'v2/channels/account-facts')
    expect(res.code, String(res.message)).toBe(0)
    expect(res.data.list.some(item => item.uid === 'local-only-uid'), '本机账号的事实也在列表里').toBe(true)
  })

  it('既不是行 id 也不是合法键时，如实报"不存在"', async () => {
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'account', id: 'acc-does-not-exist', action: 'account-positioning' } })
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('不存在')
  })
})
