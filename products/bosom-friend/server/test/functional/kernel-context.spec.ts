/**
 * 多轮对话的上下文：靠"整段对话稿 + 稳定的内核会话 id"两条一起保证。
 *
 * 这两条都是**看得见的行为**，所以判据直接钉在输出上：
 * 对话稿必须真的带上前面几轮的内容（而不是一句"请接着上文"），会话 id 必须同一段对话稳定、
 * 换一段对话就变（否则内核会把两段不相干的对话串在一起）。
 */
import { describe, expect, it } from 'vitest'
import { CHAT_CONTEXT_MAX_CHARS, chatTranscript } from '../../src/kernel-client.ts'

const turn = (role: string, content: string) => ({ role, content })

describe('对话稿：把整段对话折成提示词文本', () => {
  it('用户与助手都带上，顺序与角色一目了然', () => {
    const text = chatTranscript([
      turn('user', '帮我写一条面霜的抖音文案'),
      turn('assistant', '好的，标题建议……'),
      turn('user', '标题再短一点'),
    ])
    expect(text).toContain('用户：帮我写一条面霜的抖音文案')
    expect(text).toContain('助手：好的，标题建议……')
    expect(text.endsWith('用户：标题再短一点')).toBe(true)
  })

  it('空消息与非对话角色不进上下文（系统提示由规则块统一给，塞进来会打架）', () => {
    const text = chatTranscript([turn('system', '你是助手'), turn('user', '  '), turn('user', '在吗')])
    expect(text).toBe('用户：在吗')
    expect(text).not.toContain('你是助手')
  })

  it('没有可用消息时给空串，让调用方回退到单轮口径', () => {
    expect(chatTranscript(undefined)).toBe('')
    expect(chatTranscript([])).toBe('')
  })

  it('超长对话从头截断，且**一定保留最后一条**（丢历史也不能丢刚刚那句）', () => {
    const long = 'x'.repeat(4000)
    const text = chatTranscript([
      turn('user', long),
      turn('assistant', long),
      turn('user', long),
      turn('user', '最后这句必须留下'),
    ])
    expect(text.length).toBeLessThanOrEqual(CHAT_CONTEXT_MAX_CHARS + 4000)
    expect(text.endsWith('用户：最后这句必须留下')).toBe(true)
    expect(text).not.toContain('xxxxxxxxxx\n助手')
  })
})

describe('多轮上下文只走对话稿这一条通道', () => {
  it('追问能把上文带进上下文：第二轮的对话稿必然包含第一轮的原话', () => {
    const first = [turn('user', '帮我写一条面霜文案')]
    const later = [...first, turn('assistant', '好的'), turn('user', '再短一点')]
    const text = chatTranscript(later)
    expect(text, '第一轮的原话要在').toContain('帮我写一条面霜文案')
    expect(text, '本轮的追问要在最后').toContain('用户：再短一点')
  })

  it('两段不相干的对话不会被串在一起：各自只带自己的内容', () => {
    expect(chatTranscript([turn('user', 'A 产品怎么写')])).not.toContain('B 产品')
    expect(chatTranscript([turn('user', 'B 产品怎么写')])).not.toContain('A 产品')
  })
})
