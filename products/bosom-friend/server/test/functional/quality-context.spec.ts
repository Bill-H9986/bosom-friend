import { describe, expect, it } from 'vitest'
import { buildKnowledgeContext, buildQualityContext, recordDistillation } from '../../src/knowledge-distill.ts'
import type { KnowledgeState } from '../../src/knowledge-distill.ts'

/**
 * 质量语境：用户自己认可过的同类产出要回到下一次的上下文里（语境复利的第一环）。
 *
 * 回归背景（2026-09-22 研究"语境才是真正的护城河"）：方法论把语境分四类——领域 / 历史 / 质量 / 约束，
 * 复利来自"好语境 → 更好输出 → 学到哪些语境重要 → 改进语境文档"这个飞轮。
 * 本产品早就攒下了质量语境的原料（每条生成都进蒸馏账本、用户能给评分），
 * 但 `fewShotExamples` 只被一个只读接口用过，**从未进过任何一次模型上下文**——
 * 于是"第 N 次"永远等于"第 1 次"。
 */
const EMPTY: KnowledgeState = { notes: {}, vault: { path: '', builtIn: false }, distillations: [] }

/** 造一条蒸馏样本（默认：成功、已注入知识，因此够格进质量语境）。 */
function sample(over: Partial<Parameters<typeof recordDistillation>[1]> = {}) {
  return {
    task: 'chat',
    instruction: '给我写一条面霜的种草文案',
    output: '干皮救急就看这罐：厚实不闷，第二天上妆服帖。',
    model: 'agnes-2.5-flash',
    knowledgePaths: ['风格/口吻.md'],
    knowledgeChars: 120,
    status: 'success' as const,
    rating: 5,
    sourceId: 'gen-1',
    ...over,
  }
}

/** 用内存 store 跑一次 recordDistillation（复用产品的真实实现，不另写一份）。 */
function withRecord(knowledge: KnowledgeState, record: Parameters<typeof recordDistillation>[1]): KnowledgeState {
  const state = { ...knowledge, distillations: [...(knowledge.distillations ?? [])] }
  const store = {
    files: {
      knowledge: {
        load: () => state,
        save: (next: KnowledgeState) => { state.distillations = next.distillations },
      },
    },
  }
  // recordDistillation 收的是依赖对象（d.store.files.knowledge），不是 store 本身。
  recordDistillation({ store } as never, record)
  return state
}

describe('质量语境：给自己的成功样例进上下文', () => {
  it('没有账本时为空串（不编造样例）', () => {
    expect(buildQualityContext(EMPTY, 'chat')).toEqual({ block: '', ids: [] })
  })

  it('评分 ≥4 的成功样本进上下文，并带上要求与产出', () => {
    const state = withRecord(EMPTY, sample())
    const context = buildQualityContext(state, 'chat')
    expect(context.ids).toEqual(['dist-gen-1'])
    expect(context.block, '要说明这是谁的产出、什么水准').toContain('你自己的成功样例')
    expect(context.block).toContain('用户评分 5/5')
    expect(context.block, '样例里要有当时的要求').toContain('给我写一条面霜的种草文案')
    expect(context.block, '样例里要有当时的产出').toContain('干皮救急就看这罐')
    expect(context.block, '要明确禁止照抄事实').toContain('不要照抄其中的事实与数字')
  })

  it('任务类型要对得上：图文样例不进对话的上下文', () => {
    const state = withRecord(EMPTY, sample({ task: 'image-text', sourceId: 'gen-2' }))
    expect(buildQualityContext(state, 'chat').block).toBe('')
    expect(buildQualityContext(state, 'image-text').ids).toEqual(['dist-gen-2'])
  })

  it('失败样本与低分未注入的样本不进上下文', () => {
    const failed = withRecord(EMPTY, sample({ status: 'failed', sourceId: 'gen-3' }))
    expect(buildQualityContext(failed, 'chat').block, '失败的产出不是"好"的基准').toBe('')
    const lowRated = withRecord(EMPTY, sample({ rating: 2, knowledgePaths: [], sourceId: 'gen-4' }))
    expect(buildQualityContext(lowRated, 'chat').block, '低分且没注入知识的产出不算认可').toBe('')
  })

  it('最多两条，且单条产出截断（样例不该压过本次任务本身）', () => {
    let state = EMPTY
    for (let i = 0; i < 5; i += 1) state = withRecord(state, sample({ sourceId: 'gen-' + String(i), output: 'x'.repeat(2000) }))
    const context = buildQualityContext(state, 'chat')
    expect(context.ids.length).toBe(2)
    expect(context.block.length, '两条样例的块要有上限').toBeLessThan(1500)
  })

  it('与知识笔记命中分账：两者互不影响', () => {
    const knowledge: KnowledgeState = {
      ...EMPTY,
      notes: { '风格/口吻.md': { path: '风格/口吻.md', name: '面霜种草文案的口吻', content: '面霜种草文案的口吻要像朋友聊天，短句为主。', builtIn: false, updatedAt: '' } } as never,
    }
    const state = withRecord(knowledge, sample())
    const notes = buildKnowledgeContext(state, '给我写一条面霜的种草文案')
    const quality = buildQualityContext(state, 'chat')
    expect(notes.paths.length, '知识笔记命中走知识块').toBeGreaterThan(0)
    expect(notes.block).not.toContain('你自己的成功样例')
    expect(quality.block).not.toContain('已知知识')
  })
})
