import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness, SseFrame } from '../harness.ts'

/**
 * 助手对话的"思考过程"与流式正文。
 *
 * 回归背景（用户口径）："我的任务里要么是失败，要么一下蹦出答案，不要只有两种状态"。
 * 实测（2026-09-22 真实内核会话）：内核会发出 tool/call 与 tool/result，而这条链路原先只转发
 * 最终正文；厂商网关又**不发 text-delta**，正文只在回合结束的 assistant/message 里，
 * 于是一次对话在界面上只剩"空白转圈 → 整段出现"。
 *
 * 这里用内核桩把两条通道都固定住：
 * 1. 工具调用/结果必须实时出现在 SSE 上，并**落进任务消息**（我的任务里回看能重放）；
 * 2. 没有增量通道时，正文按模型自己的时间戳回放成多帧，而不是一帧整段。
 */
vi.mock('../../src/kernel-client.ts', async () => ({
  // 解析函数用真实实现：桩掉内核不等于可以把"怎么读事件"也换成空实现，
  // 否则这一轮要验的正是"读得对不对"。工厂里不能用顶层变量（会被提升），所以用 importActual。
  ...(({ chatTranscript, replayFrames, assistantStreamPartsOf }) => ({ chatTranscript, replayFrames, assistantStreamPartsOf }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  ),
  createKernelClient: () => ({
    prompt: async (
      _prompt: string,
      onDelta?: (text: string) => void,
      _shouldAbort?: () => boolean,
      onStep?: (step: unknown) => void,
    ) => {
      // 一次真实的"查了再答"：工具调用 → 工具结果 → 正文（分两段到达，模拟模型自己的节奏）。
      onStep?.({ kind: 'tool-call', call: { callId: 'call-1', name: 'bosom_platform_list_accounts', arguments: '{"limit":"50"}' } })
      onStep?.({ kind: 'tool-result', result: { callId: 'call-1', text: '共 1 个平台账号：\n- douyin ac0092-1790008234099', isError: false } })
      const text = '你现在绑了 1 个抖音账号：ac0092-1790008234099。'
      // 厂商网关的真实形态：不推增量，整段一起回来，但带模型自己的增量时间戳。
      return {
        text,
        stream: [
          { text: '你现在绑了 ', afterMs: 0 },
          { text: '1 个抖音账号', afterMs: 30 },
          { text: '：ac0092-1790008234099。', afterMs: 30 },
        ],
      }
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

/** 从 SSE 帧里取出指定类型的帧。 */
function framesOf(frames: SseFrame[], type: string): SseFrame[] {
  return frames.filter(frame => frame.type === type)
}

/** 一帧 stream_event 里的 event 对象。 */
function eventOf(frame: SseFrame): Record<string, unknown> {
  return (frame.event ?? {}) as Record<string, unknown>
}

describe('助手对话：过程可见（工具调用与结果）', () => {
  it('工具调用与结果既实时上 SSE，也落进任务消息', async () => {
    const res = await h.call<{ taskId?: string }>('POST', 'agent/tasks', {
      body: { prompt: '现在产品里有几个平台账号？', includePartialMessages: true },
    })
    const taskId = String(framesOf(res.sse, 'init')[0]?.taskId ?? '')
    expect(taskId, 'SSE 开头必须给出任务 id').not.toBe('')

    // ① 实时通道：工具调用以 content_block_start(tool_use) 到达，参数随后到达，结果以 user 消息到达。
    const streamEvents = framesOf(res.sse, 'stream_event')
    const toolStart = streamEvents.find(frame => {
      const block = eventOf(frame).content_block as { type?: string, name?: string } | undefined
      return block?.type === 'tool_use'
    })
    expect(toolStart, '工具调用必须实时出现在 SSE 上').toBeTruthy()
    expect((eventOf(toolStart!).content_block as { name?: string }).name).toBe('bosom_platform_list_accounts')
    const argsFrame = streamEvents.find(frame => {
      const delta = eventOf(frame).delta as { type?: string, partial_json?: string } | undefined
      return delta?.type === 'input_json_delta'
    })
    expect(argsFrame, '工具参数要跟着到达').toBeTruthy()
    expect((eventOf(argsFrame!).delta as { partial_json?: string }).partial_json).toContain('"limit"')

    const toolResult = framesOf(res.sse, 'user').find(frame => JSON.stringify(frame.message ?? '').includes('tool_result'))
    expect(toolResult, '工具结果要实时到达（否则界面上的那一步永远转圈）').toBeTruthy()
    const resultText = JSON.stringify(toolResult!.message)
    expect(resultText, '结果里要带上工具真正返回的内容').toContain('douyin ac0092-1790008234099')
    expect(resultText, '结果要挂回它那一次调用').toContain('call-1')

    // ② 落盘通道：我的任务打开这条记录时要能重放整条过程，而不是只有一句答案。
    const detail = await h.call<{ messages?: Array<Record<string, unknown>> }>('GET', 'agent/tasks/' + taskId)
    const messages = detail.data?.messages ?? []
    const kinds = messages.map(message => String(message.type))
    expect(kinds, '任务消息里必须有过程事件').toContain('stream_event')
    const persisted = JSON.stringify(messages)
    expect(persisted, '落盘的步骤要能被 convertMessages 还原成 workflowSteps').toContain('content_block_start')
    expect(persisted).toContain('bosom_platform_list_accounts')
    expect(persisted).toContain('tool_result')
    // 过程事件要排在最终答复之前：顺序错了，界面上步骤会显示在答案后面。
    expect(kinds.lastIndexOf('stream_event'), '过程在答复之前').toBeLessThan(kinds.lastIndexOf('assistant'))
  })

  it('没有增量通道时正文按模型自己的时间戳回放成多帧', async () => {
    const res = await h.call('POST', 'agent/tasks', {
      body: { prompt: '现在产品里有几个平台账号？', includePartialMessages: true },
    })
    const deltas = framesOf(res.sse, 'stream_event')
      .map(frame => eventOf(frame).delta as { type?: string, text?: string } | undefined)
      .filter(delta => delta?.type === 'text_delta')
      .map(delta => String(delta?.text ?? ''))
    expect(deltas.length, '正文不能只有一帧（那正是"一下蹦出答案"）').toBeGreaterThan(1)
    expect(deltas.join(''), '回放不得改动一个字').toBe('你现在绑了 1 个抖音账号：ac0092-1790008234099。')
  })
})
