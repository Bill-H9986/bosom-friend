import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 「越用越省」要能覆盖**所有**模型调用，而不是只有对话（S5 审计的收尾）。
 *
 * 此前只有助手那条路记度量（轮数/耗时/上下文），对象动作、接待建议、长视频写稿都不记——
 * 于是趋势接口看到的只是"聊天变快了"，而产品真正要证明的是"同一类活儿越干越省"。
 *
 * 判据看三件事：① 非助手路径也写下度量；② 趋势接口把它们算进去；
 * ③ **没有度量样本时不下结论**（老样本没度量，拿 0 顶替就是把结论做假）。
 */

/** 这一轮"模型"回什么。 */
let reply = '模型给的正文'

vi.mock('../../src/kernel-client.ts', async () => ({
  ...((({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  )),
  createKernelClient: () => ({
    prompt: async (_prompt: string, onDelta?: (text: string) => void) => {
      // 刻意等一小会儿：耗时要不是 0，否则"耗时下降"这件事没法被观测。
      await new Promise(resolve => setTimeout(resolve, 5))
      onDelta?.(reply)
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

/** 跑一次对象动作，返回它的样本。 */
async function runAction(title: string): Promise<{ toolCalls?: number, elapsedMs?: number, contextChars?: number }> {
  const created = await h.call<{ _id?: string }>('POST', 'contents/drafts', {
    body: { groupId: 'mg-persist', title, desc: '正文', mediaList: [] },
  })
  const id = String(created.data?._id ?? '')
  reply = '改过的标题 ' + title
  const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })
  expect(res.code, String(res.message)).toBe(0)
  const dataset = await h.call<{ list: Array<{ sourceId: string, toolCalls?: number, elapsedMs?: number, contextChars?: number }> }>(
    'GET',
    'knowledge/distill/dataset',
    { query: { task: 'chat' } },
  )
  const sample = dataset.data.list.find(item => item.sourceId === 'object-action-draft-' + id + '-draft-title')
  expect(sample, '对象动作要留下样本').toBeDefined()
  return sample!
}

describe('度量覆盖所有模型调用', () => {
  it('对象动作也写下轮数/耗时/上下文（此前只有助手那条路记）', async () => {
    const sample = await runAction('夏日特调')
    expect(sample.toolCalls, '纯文本调用没调工具，记 0 也是度量值').toBe(0)
    expect(sample.elapsedMs, '耗时要是真实测出来的').toBeGreaterThan(0)
    expect(typeof sample.contextChars, '上下文就算这次没命中知识，也要记 0').toBe('number')
  })

  it('接待建议同样带度量', async () => {
    reply = '现货 48 小时内发出。'
    await h.call('POST', 'v2/customer-reception/suggest', {
      body: { message: '随便问一句不命中规则的话', platform: 'xhs', accountId: 'acc-1' },
    })
    const dataset = await h.call<{ list: Array<{ sourceId: string, toolCalls?: number, elapsedMs?: number }> }>(
      'GET',
      'knowledge/distill/dataset',
      { query: { task: 'chat' } },
    )
    const sample = dataset.data.list.find(item => item.sourceId.startsWith('reception-suggest-'))
    expect(sample, '接待建议要留下样本').toBeDefined()
    expect(typeof sample!.toolCalls).toBe('number')
    expect(sample!.elapsedMs).toBeGreaterThan(0)
  })
})

describe('越用越省：趋势接口读的是同一本账', () => {
  it('把非助手路径的样本也算进来', async () => {
    await runAction('第二次跑')
    const trend = await h.call<{ measured: number, first: { toolCalls: number, elapsedMs: number } | null, recent: { samples: number } | null }>(
      'GET',
      'knowledge/distill/trend',
      { query: { task: 'chat', recent: '5' } },
    )
    expect(trend.data.measured, '对象动作与接待建议的样本都要被算进"有度量"').toBeGreaterThanOrEqual(3)
    expect(trend.data.first, '第一条度量样本要给出来').not.toBeNull()
    expect(trend.data.first!.elapsedMs).toBeGreaterThan(0)
    expect(trend.data.recent!.samples).toBeGreaterThan(0)
  })

  it('没有度量样本时不下结论（不拿 0 顶替）', async () => {
    // 另一个任务类型（video）此时一条样本都没有。
    const trend = await h.call<{ measured: number, first: unknown, recent: unknown }>(
      'GET',
      'knowledge/distill/trend',
      { query: { task: 'video' } },
    )
    expect(trend.data.measured).toBe(0)
    expect(trend.data.first).toBeNull()
    expect(trend.data.recent).toBeNull()
  })
})
