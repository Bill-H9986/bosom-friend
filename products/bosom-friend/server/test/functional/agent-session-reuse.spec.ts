import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 一个任务 = 一个会话（ADR-003 口径一的地基）。
 *
 * 回归背景：不池化时每轮都新起内核进程、开新会话、用完即关——多轮上下文只能由服务端把历史
 * 折成文本重发（上限 12000 字，每轮重发一次）。池化之后同一个任务的第二轮只送**本轮这一句**，
 * 前几轮由会话承担；冷启动那一轮才喂历史。
 *
 * 这里用内核桩把三件事钉住：① 同一任务只建一次客户端；② 续轮不再重发历史；
 * ③ 换任务换会话；④ 中断之后会话作废（下一轮重新冷启动并喂一次历史）。
 */
const created: Array<{ sessionId?: string }> = []
const prompts: string[] = []
/** 把下一轮 prompt 挂住，好让"中断"落在生成途中（否则桩瞬间答完，中断永远赶不上）。 */
let holdNext = false
let releaseHold: (() => void) | undefined
let heldStarted = false

vi.mock('../../src/kernel-client.ts', async () => ({
  // 解析函数用真实实现：桩掉内核不等于可以把"历史怎么折"也换成空实现。
  ...(({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  ),
  createKernelClient: (options?: { sessionId?: string }) => {
    created.push({ ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }) })
    let closed = false
    return {
      prompt: async (prompt: string, onDelta?: (text: string) => void) => {
        if (closed) throw new Error('内核已被关闭，却还在用它提问')
        prompts.push(prompt)
        if (holdNext) {
          holdNext = false
          heldStarted = true
          await new Promise<void>((resolve) => { releaseHold = resolve })
        }
        const text = '这是第 ' + String(prompts.length) + ' 次回答。'
        onDelta?.(text)
        return { text }
      },
      close: async () => { closed = true },
    }
  },
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

/** 发一轮对话，返回任务 id。 */
async function say(prompt: string): Promise<string> {
  const res = await h.call<{ taskId?: string }>('POST', 'agent/tasks', {
    body: { prompt, includePartialMessages: true },
  })
  const init = res.sse.find(frame => frame.type === 'init')
  return String(init?.taskId ?? '')
}

describe('一个任务 = 一个会话：上下文由会话承担，不再每轮重发历史', () => {
  it('同一任务的两轮只建一次内核，第二轮不再重发第一轮正文', async () => {
    created.length = 0
    prompts.length = 0
    const taskId = await say('第一句话：请记住我喜欢简短的回答。')
    expect(taskId).not.toBe('')
    const afterFirst = created.length
    expect(afterFirst, '第一轮要建一个内核（冷启动）').toBe(1)
    expect(created[0]!.sessionId, '会话 id 以任务为单位').toContain(taskId)

    await say2('第二句话：我刚才让你记住什么？', taskId)
    expect(created.length, '第二轮必须复用同一个内核，而不是再起一个进程').toBe(afterFirst)
    const second = prompts[prompts.length - 1]!
    expect(second, '第二轮提示词里只有本轮这一句').toContain('第二句话')
    expect(second, '第二轮不得再重发第一轮的正文（历史在会话里）').not.toContain('第一句话')
    expect(prompts[0], '冷启动那一轮才喂历史').toContain('第一句话')
  })

  it('换一条任务就换一个会话', async () => {
    created.length = 0
    const first = await say('任务 A 的第一句。')
    const second = await say('任务 B 的第一句。')
    expect(first).not.toBe(second)
    expect(created.length).toBe(2)
    expect(created[0]!.sessionId).not.toBe(created[1]!.sessionId)
  })

  it('中断之后会话作废：下一轮重新冷启动并喂一次历史', async () => {
    created.length = 0
    prompts.length = 0
    holdNext = true
    heldStarted = false
    // 不 await：这一轮要挂住，中断才有机会落在生成途中。
    const turn = h.call('POST', 'agent/tasks', { body: { prompt: '这一轮会被中断。', includePartialMessages: true } })
    while (!heldStarted) await new Promise(resolve => setTimeout(resolve, 5))
    expect(created.length, '挂住之前已经建好内核').toBe(1)
    // 会话 id 就是"任务 id + 进程内序号"：从这里取回这条任务，比翻落盘列表可靠。
    const heldTaskId = String(created[0]!.sessionId).replace(/-s\d+$/, '')
    const aborted = await h.call('POST', 'agent/tasks/' + heldTaskId + '/abort', { body: {} })
    expect(aborted.code, '中断要落在正在生成的那一次上').toBe(0)
    expect((aborted.data as { interrupted?: boolean }).interrupted, '中断必须真的落到在跑的那一次').toBe(true)
    releaseHold?.()
    await turn
    await say2('中断之后再说一句。', heldTaskId)
    expect(created.length, '会话被中断后必须换一个新的').toBe(2)
    expect(prompts[prompts.length - 1], '新会话要重新喂一次历史').toContain('这一轮会被中断')
  })
})

/** 对既有任务续一轮（走同一个 SSE 入口，带 taskId）。 */
async function say2(prompt: string, taskId: string): Promise<void> {
  await h.call('POST', 'agent/tasks', { body: { prompt, taskId, includePartialMessages: true } })
}
