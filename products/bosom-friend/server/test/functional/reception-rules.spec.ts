import { describe, expect, it } from 'vitest'
import { matchReceptionRules } from '../../src/reception-rules.ts'
import type { ReceptionRule } from '../../src/types.ts'

/**
 * 接待规则匹配契约（含兜底规则）。
 *
 * 现实触发面：客户点名要求 7×24 自动接待，但真实消息（粉丝群消息等）几乎不会命中
 * 电商关键词模板；没有兜底规则时这些消息既无模板回复也无 AI 回复，接待形同不存在。
 */
function rule(patch: Partial<ReceptionRule>): ReceptionRule {
  return {
    id: 'r1',
    name: '规则',
    platforms: [],
    keywords: [],
    replyMode: 'template',
    template: '模板回复',
    enabled: true,
    priority: 10,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...patch,
  }
}

describe('接待规则匹配', () => {
  it('空关键词的普通规则不匹配任何消息（避免误配的空规则吞掉全部消息）', () => {
    const outcome = matchReceptionRules([rule({ keywords: [] })], { message: '你好', platform: 'douyin' })
    expect(outcome.matched).toBe(false)
  })

  it('matchAll 兜底规则命中任意消息，并标记需要 AI 生成回复', () => {
    const outcome = matchReceptionRules(
      [rule({ id: 'fallback', name: '兜底', matchAll: true, replyMode: 'ai', priority: 999 })],
      { message: '群消息：你收到一条新类型消息', platform: 'douyin' },
    )
    expect(outcome.matched).toBe(true)
    expect(outcome.ruleId).toBe('fallback')
    expect(outcome.aiUsed).toBe(true)
    expect(outcome.reply).toBeUndefined()
  })

  it('关键词规则优先于兜底规则（priority 更小先命中）', () => {
    const outcome = matchReceptionRules(
      [
        rule({ id: 'fallback', matchAll: true, replyMode: 'ai', priority: 999 }),
        rule({ id: 'kw', keywords: ['发货'], template: '模板：发货', priority: 10 }),
      ],
      { message: '什么时候发货', platform: 'douyin' },
    )
    expect(outcome.ruleId).toBe('kw')
    expect(outcome.reply).toBe('模板：发货')
    expect(outcome.aiUsed).toBe(false)
  })
})
