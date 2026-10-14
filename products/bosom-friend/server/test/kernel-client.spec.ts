/**
 * 内核客户端文本通道测试：agnes 不发 text-delta，正文只在 assistant/message 里。
 *
 * 回归背景（DEF-072）：assistantTextOf 只认 assistant/chunk 的 text-delta，实测厂商网关
 * 全程不推增量，导致每个生成请求都空手而归、等满超时后报「未知错误」。
 *
 * @module test/kernel-client.test
 */
import { describe, expect, it } from 'vitest'
import {
  REPLAY_MAX_FRAMES,
  REPLAY_MAX_GAP_MS,
  assistantMessageTextOf,
  assistantStreamPartsOf,
  assistantTextOf,
  replayFrames,
  toolCallOf,
  toolResultOf,
} from '../src/kernel-client.ts'

/** 构造一条 session.event 通知。 */
function notify(event: unknown): unknown {
  return { method: 'session.event', params: { sessionId: 's1', event } }
}

describe('assistantTextOf', () => {
  it('取 text-delta 增量', () => {
    expect(assistantTextOf(notify({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '你好' } } }))).toBe('你好')
  })

  it('对整段 assistant/message 返回空串（增量通道不该重复计数）', () => {
    expect(assistantTextOf(notify({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } },
    }))).toBe('')
  })
})

describe('assistantMessageTextOf', () => {
  it('取整段正文（厂商网关的真实形态）', () => {
    expect(assistantMessageTextOf(notify({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '干痒起皮？那是你的面霜该换了。' }] } },
    }))).toBe('干痒起皮？那是你的面霜该换了。')
  })

  it('工具回合没有 text 块时返回空串，不会被误当正文', () => {
    expect(assistantMessageTextOf(notify({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'get_goal' }] } },
    }))).toBe('')
  })

  it('多个 text 块按顺序拼接', () => {
    expect(assistantMessageTextOf(notify({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '第一镜' }, { type: 'tool-call' }, { type: 'text', text: '第二镜' }] } },
    }))).toBe('第一镜第二镜')
  })

  it('忽略非 session.event 通知与畸形载荷', () => {
    expect(assistantMessageTextOf({ method: 'session.status', params: { status: 'idle' } })).toBe('')
    expect(assistantMessageTextOf(notify({ type: 'assistant/message', data: {} }))).toBe('')
    expect(assistantMessageTextOf(null)).toBe('')
  })
})

describe('toolCallOf / toolResultOf：过程事件的读法（形状以 2026-09-22 真实会话为准）', () => {
  it('取工具调用的 id、名字与原始参数', () => {
    expect(toolCallOf(notify({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call_846af1f1', name: 'bosom_platform_list_accounts', arguments: '{"limit":"50"}' },
    }))).toEqual({ callId: 'call_846af1f1', name: 'bosom_platform_list_accounts', arguments: '{"limit":"50"}' })
  })

  it('取工具结果的文本与失败标记（tool-result 块套 text 块）', () => {
    expect(toolResultOf(notify({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_846af1f1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call_846af1f1',
            content: [{ type: 'text', text: '共 1 个平台账号' }],
            isError: false,
          }],
        },
      },
    }))).toEqual({ callId: 'call_846af1f1', text: '共 1 个平台账号', isError: false })
  })

  it('非过程事件一律返回 null，不与正文通道抢事件', () => {
    expect(toolCallOf(notify({ type: 'assistant/message', data: {} }))).toBeNull()
    expect(toolResultOf(notify({ type: 'tool/call', data: { callId: 'c', name: 'n' } }))).toBeNull()
    expect(toolCallOf({ method: 'session.status', params: { status: 'running' } })).toBeNull()
    expect(toolResultOf(null)).toBeNull()
    // 缺 callId 的 tool/result 无法挂回那一步，按不可用丢弃（宁可少显示一步，也不要挂错）。
    expect(toolResultOf(notify({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: 'x' }] } } }))).toBeNull()
  })
})

describe('assistantStreamPartsOf：从 assistant/message 里取模型真实的增量时间戳', () => {
  it('按 time0 + dt 还原每一段的等待时长', () => {
    const parts = assistantStreamPartsOf(notify({
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: '你现在绑了 1 个账号' }] },
        stream: [{ type: 'text-chunks', time0: 1000, index: 0, dt: [0, 30, 40], texts: ['你现在绑了 ', '1 个', '账号'] }],
      },
    }))
    expect(parts.map(part => part.text)).toEqual(['你现在绑了 ', '1 个', '账号'])
    expect(parts[0]!.afterMs, '首段不等待').toBe(0)
    expect(parts[1]!.afterMs).toBe(30)
    expect(parts[2]!.afterMs).toBe(40)
  })

  it('也认未被打包的裸 text-delta chunk', () => {
    const parts = assistantStreamPartsOf(notify({
      type: 'assistant/message',
      data: {
        stream: [
          { type: 'chunk', time: 500, chunk: { type: 'text-delta', text: '第一段' } },
          { type: 'chunk', time: 560, chunk: { type: 'text-delta', text: '第二段' } },
        ],
      },
    }))
    expect(parts.map(part => part.text)).toEqual(['第一段', '第二段'])
    expect(parts[1]!.afterMs).toBe(60)
  })

  it('推理增量不算正文（它不该出现在正文气泡里）', () => {
    const parts = assistantStreamPartsOf(notify({
      type: 'assistant/message',
      data: { stream: [{ type: 'reasoning-chunks', time0: 0, index: 0, dt: [0, 10], texts: ['想一下', '再想一下'] }] },
    }))
    expect(parts).toEqual([])
  })

  it('非 assistant/message 与畸形载荷返回空数组', () => {
    expect(assistantStreamPartsOf(notify({ type: 'tool/call', data: {} }))).toEqual([])
    expect(assistantStreamPartsOf(notify({ type: 'assistant/message', data: {} }))).toEqual([])
    expect(assistantStreamPartsOf(undefined)).toEqual([])
  })
})

describe('replayFrames：把真实增量压成回放节拍（文本一字不改）', () => {
  it('短流按原节奏回放', () => {
    const frames = replayFrames([
      { text: '你好', afterMs: 0 },
      { text: '世界', afterMs: 40 },
    ])
    expect(frames.map(frame => frame.text)).toEqual(['你好', '世界'])
    expect(frames[0]!.waitMs, '首帧立刻显示').toBe(0)
    expect(frames[1]!.waitMs).toBe(40)
  })

  it('长等待被压缩进总预算（用户已经等过模型一次）', () => {
    const frames = replayFrames([
      { text: '开头', afterMs: 0 },
      { text: '很久以后', afterMs: 20000 },
    ])
    expect(frames[1]!.waitMs, '单帧等待有上限').toBeLessThanOrEqual(REPLAY_MAX_GAP_MS)
    expect(frames.map(frame => frame.text).join(''), '文本与顺序不变').toBe('开头很久以后')
  })

  it('帧数超过上限时合并，且合并不丢字', () => {
    const parts = Array.from({ length: 400 }, (_, index) => ({ text: String(index % 10), afterMs: 5 }))
    const frames = replayFrames(parts)
    expect(frames.length).toBeLessThanOrEqual(REPLAY_MAX_FRAMES)
    expect(frames.map(frame => frame.text).join('')).toBe(parts.map(part => part.text).join(''))
  })

  it('没有增量时返回空数组（调用方据此跳过回放）', () => {
    expect(replayFrames([])).toEqual([])
    expect(replayFrames([{ text: '', afterMs: 10 }])).toEqual([])
  })
})
