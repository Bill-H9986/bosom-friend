import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 语境复利的端到端：**上一次被用户认可的产出，必须出现在下一次的上下文里**。
 *
 * 这条链路此前是断的：每条对话/生成都进了蒸馏账本（原料齐），但 `fewShotExamples` 只被一个
 * 只读接口用过，从未进过模型上下文——用户评了五分的稿子，下一次生成看不到（永远第一次）。
 *
 * 这里走完整条产品链路：真对话一轮 → 给那一轮评分 → 再对话一轮 → 断言第二次送进内核的提示词里
 * 带上了第一轮的产出，并且新样本的账本里记着"用了哪条样例"。
 */
const prompts: string[] = []
let answerSeq = 0

vi.mock('../../src/kernel-client.ts', async () => ({
  ...(({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  ),
  createKernelClient: () => ({
    prompt: async (prompt: string, onDelta?: (text: string) => void) => {
      prompts.push(prompt)
      answerSeq += 1
      const text = answerSeq === 1
        ? '第一版：干皮救急就看这罐，厚实不闷，第二天上妆服帖。'
        : '第二版：' + (prompt.includes('第一版') ? '（已参考上一版）' : '（没有上一版）') + '干皮救急就看这罐。'
      onDelta?.(text)
      return { text }
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

/** 发一轮对话。 */
async function say(prompt: string, taskId?: string): Promise<void> {
  await h.call('POST', 'agent/tasks', {
    body: { prompt, ...(taskId === undefined ? {} : { taskId }), includePartialMessages: true },
  })
}

describe('质量语境接线：评过分的产出回到下一次上下文', () => {
  it('第一轮产出 → 评分 → 第二轮上下文里出现它，且账本记下用了哪条样例', async () => {
    prompts.length = 0
    answerSeq = 0
    await say('给我写一条面霜的种草文案。')
    expect(prompts.length).toBe(1)
    expect(prompts[0], '第一次当然还没有样例可用').not.toContain('你自己的成功样例')

    // 找到这一轮的账本样本（产品自己写的），给它评分——这一步就是"用户点了五星"。
    const list = await h.call<{ list: Array<{ id: string, output: string }> }>('GET', 'knowledge/distill/dataset', { query: { task: 'chat', limit: '10' } })
    const sample = list.data.list[0]!
    expect(sample.output).toContain('第一版')
    const rated = await h.call<{ ok: boolean }>('POST', 'knowledge/distill/rate', { body: { id: sample.id, rating: 5 } })
    expect(rated.data.ok, '评分要落进账本').toBe(true)

    await say('再写一条面霜的种草文案，这次更短一点。')
    expect(prompts.length).toBe(2)
    const second = prompts[1]!
    expect(second, '第二次的上下文里要带上上一版产出').toContain('第一版：干皮救急就看这罐')
    expect(second, '并说明这是自己的成功样例、不许照抄事实').toContain('你自己的成功样例')

    // 账本要留下"这一次用了哪条样例"：自进化的判据靠它，不能靠感觉。
    const after = await h.call<{ list: Array<{ id: string, exampleIds?: string[] }> }>('GET', 'knowledge/distill/dataset', { query: { task: 'chat', limit: '10' } })
    const used = after.data.list.find(item => (item.exampleIds ?? []).length > 0)
    expect(used, '新样本要记下注入的样例 id').toBeTruthy()
    expect(used!.exampleIds).toContain(sample.id)
  })

  it('样例只进同类型任务：聊天样例不会跑到内容创作上去', async () => {
    // 上面那条已经给 chat 攒下一条五星样例；这里换一种任务类型，它不该被串过去。
    prompts.length = 0
    const created = await h.call<{ taskIds?: string[] }>('POST', 'ai/draft-generation/image-text', {
      body: { topic: '秋冬保湿面霜', prompts: ['干皮救急'], platforms: ['xiaohongshu'], count: 1 },
    })
    expect(created.code, '生成任务要建得起来：' + String(created.message)).toBe(0)
    // 生成是异步跑在 setTimeout 里的，等它真的把提示词送进内核。
    for (let i = 0; i < 60 && prompts.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 50))
    const latest = prompts[prompts.length - 1] ?? ''
    expect(latest, '对话样例不得出现在图文生成的上下文里').not.toContain('你自己的成功样例')
  })
})
