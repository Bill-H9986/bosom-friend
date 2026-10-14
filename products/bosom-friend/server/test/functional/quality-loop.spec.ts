import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 复利飞轮：**上一次被认可的产出，要出现在下一次的提示词里**（ADR-004 S4）。
 *
 * 为什么单独立一个判据：这条链此前只有"零件级"的用例——`buildQualityContext` 能挑出样本、
 * `POST knowledge/distill/rate` 能改评分，但**"评分之后下一个动作真的带上了它"这一跳从没被验过**。
 * 而这一跳正是"越用越好"的全部内容：零件都对、接线没接，飞轮就不会转（DEF-138 就是这么来的）。
 *
 * 判据看的是**真实送给模型的提示词**（从被 mock 的内核客户端手里截下来的那一段），
 * 不是"某个函数返回了非空字符串"。
 */

/** 这一轮"模型"会回什么。 */
let reply = '第一版标题'
/** 每一次调用真正送进内核的提示词，按顺序记下来。 */
const prompts: string[] = []

vi.mock('../../src/kernel-client.ts', async () => ({
  ...((({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  )),
  createKernelClient: () => ({
    prompt: async (prompt: string, onDelta?: (text: string) => void) => {
      prompts.push(prompt)
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

/** 建一条草稿并跑一次「AI 改标题」，返回这一轮送进模型的提示词。 */
async function runTitleAction(title: string): Promise<string> {
  const created = await h.call<{ _id?: string }>('POST', 'contents/drafts', {
    body: { groupId: 'mg-persist', title, desc: '正文先放这儿', mediaList: [] },
  })
  const id = String(created.data?._id ?? '')
  prompts.length = 0
  const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })
  expect(res.code, String(res.message)).toBe(0)
  return prompts[0] ?? ''
}

/** 账本里最新的那条 chat 样本。 */
async function latestSample(): Promise<{ id: string, sourceId: string, rating: number }> {
  const res = await h.call<{ list: Array<{ id: string, sourceId: string, rating: number }> }>(
    'GET',
    'knowledge/distill/dataset',
    { query: { task: 'chat' } },
  )
  expect(res.data.list.length).toBeGreaterThan(0)
  return res.data.list[0]!
}

describe('复利飞轮：上次的产出进下一次的上下文', () => {
  it('没被认可的产出不进上下文（飞轮的起点是"认可"，不是"跑过一次"）', async () => {
    reply = '第一版标题'
    const first = await runTitleAction('旧标题')
    expect(first).not.toContain('[你自己的成功样例')
    const second = await runTitleAction('旧标题二')
    // 上一条样本评分是 0、也没注入过知识：它不该被当成范例送回来。
    expect(second).not.toContain('[你自己的成功样例')
    expect(second).not.toContain('第一版标题')
  })

  it('评了 5 分之后，下一次同类动作的提示词里带上它（这一跳就是"越用越好"）', async () => {
    reply = '被认可的那一版标题'
    const before = await runTitleAction('旧标题三')
    expect(before).not.toContain('被认可的那一版标题')

    const sample = await latestSample()
    expect(sample.rating, '新样本的初始评分是 0').toBe(0)
    const rated = await h.call<{ ok: boolean }>('POST', 'knowledge/distill/rate', { body: { id: sample.id, rating: 5 } })
    expect(rated.data.ok).toBe(true)

    const after = await runTitleAction('旧标题四')
    expect(after, '评分 ≥4 的样本要作为成功样例进上下文').toContain('[你自己的成功样例')
    expect(after, '而且带的是它的产出本身').toContain('被认可的那一版标题')
    expect(after, '要让模型知道这是它自己交过的东西').toContain('用户评分 5/5')
  })

  it('同一条对象再跑一次，不会把用户已经认可的样本冲掉', async () => {
    reply = '第二次跑出来的标题'
    const created = await h.call<{ _id?: string }>('POST', 'contents/drafts', {
      body: { groupId: 'mg-persist', title: '反复改的标题', desc: '正文', mediaList: [] },
    })
    const id = String(created.data?._id ?? '')

    prompts.length = 0
    await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })
    const sample = await latestSample()
    await h.call('POST', 'knowledge/distill/rate', { body: { id: sample.id, rating: 5 } })

    const sourceId = sample.sourceId
    // 同一个对象再点一次：来源 id 是稳定的，覆盖同一条就等于把用户的 5 分抹掉。
    reply = '重跑之后的标题'
    prompts.length = 0
    await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })

    const rows = await h.call<{ list: Array<{ sourceId: string, rating: number, output: string }> }>(
      'GET',
      'knowledge/distill/dataset',
      { query: { task: 'chat' } },
    )
    const mine = rows.data.list.filter(item => item.sourceId === sourceId)
    expect(mine.some(item => item.rating === 5), '用户打过的 5 分还在').toBe(true)
    expect(mine.some(item => item.output === '重跑之后的标题'), '这一次重跑也要入账').toBe(true)

    const third = await runTitleAction('另一个对象')
    expect(third, '被认可过的那条产出仍然要能作为样例出现').toContain('第二次跑出来的标题')
  })
})
