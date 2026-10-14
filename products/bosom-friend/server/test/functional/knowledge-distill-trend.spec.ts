import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import { distillTrend } from '../../src/knowledge-distill.ts'

/**
 * "越用越省"的裁判（ADR-003 口径四的判据）。
 *
 * 为什么要有它：没有度量时，"第 N 次比第 1 次快"只能靠感觉说——而感觉在这个问题上一文不值
 * （模型快一点慢一点都比"学会了"的影响大）。所以先把**口径**钉死：
 * 只统计有度量的样本、"第 1 次"取最早、对比取中位数（不被单次抖动带偏）。
 *
 * 轮数（toolCalls）是主判据：耗时被模型与网络抖动淹没，而轮数反映"要不要反复试错"。
 */

let reply = '好的。'

vi.mock('../../src/kernel-client.ts', async () => ({
  ...(({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  ),
  createKernelClient: () => ({
    prompt: async (_prompt: string, onDelta?: (text: string) => void) => {
      if (reply !== '') onDelta?.(reply)
      return { text: reply }
    },
    close: async () => {},
  }),
}))

describe('口径：只有带度量的样本算数，对比取中位数', () => {
  it('一条度量样本都没有时给空的摘要，不拿 0 顶替', () => {
    const trend = distillTrend([{ createdAt: 't1' }, { createdAt: 't2' }])
    expect(trend).toEqual({ measured: 0, first: null, recent: null })
  })

  it('没有度量的老样本被忽略（拿 0 顶替会把结论做假）', () => {
    const trend = distillTrend([
      { createdAt: 't1' },
      { createdAt: 't2', toolCalls: 3, elapsedMs: 100, contextChars: 500 },
    ])
    expect(trend.measured).toBe(1)
    expect(trend.first?.toolCalls).toBe(3)
  })

  it('"第 1 次"取最早那条（按时间，不看数组顺序）', () => {
    const trend = distillTrend([
      { createdAt: 't9', toolCalls: 1 },
      { createdAt: 't1', toolCalls: 6 },
    ])
    expect(trend.first?.createdAt).toBe('t1')
    expect(trend.first?.toolCalls).toBe(6)
  })

  it('"最近"取最后 N 条的中位数：轮数从 5 降到 2 看得出来', () => {
    const trend = distillTrend([
      { createdAt: 't1', toolCalls: 5, elapsedMs: 9000, contextChars: 900 },
      { createdAt: 't2', toolCalls: 3, elapsedMs: 7000, contextChars: 700 },
      { createdAt: 't3', toolCalls: 2, elapsedMs: 5000, contextChars: 700 },
      { createdAt: 't4', toolCalls: 2, elapsedMs: 4000, contextChars: 700 },
    ], 3)
    expect(trend.measured).toBe(4)
    expect(trend.first?.toolCalls).toBe(5)
    expect(trend.recent?.toolCalls).toBe(2)
    expect(trend.recent?.contextChars).toBe(700)
  })

  it('偶数条取中间两个的平均（不偏向任何一侧）', () => {
    const trend = distillTrend([
      { createdAt: 't1', toolCalls: 1 },
      { createdAt: 't2', toolCalls: 2 },
      { createdAt: 't3', toolCalls: 3 },
      { createdAt: 't4', toolCalls: 4 },
    ])
    expect(trend.recent?.toolCalls).toBe(2.5)
  })
})

describe('链路真的记了度量：账本与裁判接口都能读到', () => {
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

  it('一轮对话后，账本里有轮数与耗时；裁判接口读得到', async () => {
    await h.call('POST', 'agent/tasks', { body: { prompt: '你好。', includePartialMessages: true } })
    const dataset = await h.call<{ list: Array<{ task: string, toolCalls?: number, elapsedMs?: number, contextChars?: number }> }>(
      'GET', 'knowledge/distill/dataset', { query: { task: 'chat' } },
    )
    const sample = dataset.data.list[0]!
    expect(typeof sample.toolCalls, '轮数必须落账').toBe('number')
    expect(typeof sample.elapsedMs, '耗时必须落账').toBe('number')
    expect(typeof sample.contextChars, '上下文规模必须落账').toBe('number')

    const trend = await h.call<{ measured: number, first: { toolCalls: number } | null }>(
      'GET', 'knowledge/distill/trend', { query: { task: 'chat' } },
    )
    expect(trend.code).toBe(0)
    expect(trend.data.measured, '裁判接口要能看到这条度量样本').toBeGreaterThanOrEqual(1)
  })
})
