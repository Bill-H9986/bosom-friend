import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { JsonFile } from '../../src/store.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import type { KnowledgeState } from '../../src/knowledge-distill.ts'

/**
 * 长视频那两条模型调用也要带语境、也要留痕（S5 审计的收口，DEF-156）。
 *
 * 审计发现：completeWithModel（选题增强 / 排分镜）与 writeLongVideoScript（写稿）
 * 调完模型**什么都不记**，而且提示词里没有用户自己的资料——写内容却空手去问模型。
 *
 * 这两条路的判据不好写，因为它们在编排层深处。这里挑了两个**不需要厂商、不需要 ffmpeg**
 * 的入口：POST long-videos/enhance-topic（走 completeWithModel）与
 * POST long-videos/:taskId/extend-script（走 writeScript，用 scene 生成器）。
 */

const prompts: string[] = []
let reply = '这是模型写的一段稿子'

vi.mock('../../src/kernel-client.ts', async () => ({
  ...((({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  )),
  createKernelClient: () => ({
    prompt: async (prompt: string, onDelta?: (text: string) => void) => {
      prompts.push(prompt)
      onDelta?.(reply)
      return { text: reply }
    },
    close: async () => {},
  }),
}))

let h: Harness
const knowledgeDefault = () => ({ notes: {}, vault: { path: '', builtIn: true } })

/** 账本里的全部样本。 */
function samples(): Array<{ sourceId: string, task: string, knowledgePaths: string[], instruction: string }> {
  const knowledge = new JsonFile<KnowledgeState>(h.dataRoot + '/knowledge.json', knowledgeDefault).load()
  return (knowledge.distillations ?? []) as never
}

beforeAll(async () => {
  h = createHarness()
  // 用户自己的产品资料：模型写稿/写选题时必须在场。
  const file = h.dataRoot + '/knowledge.json'
  const knowledge = new JsonFile<KnowledgeState>(file, knowledgeDefault).load()
  knowledge.notes = {
    '探针资料：产品卖点.md': {
      name: '探针资料',
      content: '# 露营地垫\n\n三层复合，收纳后只有矿泉水瓶大小；\n承重 200 公斤，雨天可直接铺在湿地上。\n',
    },
  }
  new JsonFile<KnowledgeState>(file, knowledgeDefault).save(knowledge)
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

describe('选题增强（completeWithModel）', () => {
  it('写出来的东西带着用户自己的资料，并留下一条样本', async () => {
    prompts.length = 0
    reply = '露营地垫：三层复合，收纳后只有矿泉水瓶大小，承重 200 公斤。'
    const res = await h.call<{ topic: string }>('POST', 'long-videos/enhance-topic', {
      body: { topic: '露营地垫 收纳后只有矿泉水瓶大小 承重 200 公斤' },
    })
    expect(res.code, String(res.message)).toBe(0)
    // ① 语境真的进了提示词：资料里的原文在。
    expect(prompts.join('\n'), '产品资料要进提示词').toContain('三层复合')
    expect(prompts.join('\n')).toContain('承重 200 公斤')
    // ② 留痕：账本里有这一条，并记下命中了哪几篇。
    const sample = samples().find(item => item.sourceId.startsWith('text-call-h'))
    expect(sample, '每一次模型调用都要留一条样本').toBeDefined()
    expect(sample!.task, '归到视频类，下一次写视频时能作为成功样例回来').toBe('video')
    expect(sample!.knowledgePaths).toContain('探针资料：产品卖点.md')
  })
})

/** 种一条待补写的长视频任务：只要任务记录在，extend-script 这条路不需要厂商也不需要 ffmpeg。 */
function seedTask(taskId: string, targetSeconds: number): void {
  new JsonFile<unknown[]>(h.dataRoot + '/long-video-tasks.json', () => []).save([{
    id: taskId,
    topic: '露营地垫 收纳后只有矿泉水瓶大小',
    targetSeconds,
    producer: 'scene',
    scriptText: '露营地垫很轻。',
    scriptChars: 6,
    status: 'generating',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  }])
}

describe('长视频写稿（writeLongVideoScript）', () => {
  it('补写稿件时用任务 id 留痕，并带上资料', async () => {
    const taskId = 'lv-trace-1'
    seedTask(taskId, 8)
    prompts.length = 0
    reply = '露营地垫是三层复合的，收纳以后只有一瓶矿泉水那么大，承重能到 200 公斤，下雨天直接铺在湿地上也不怕。'
    const res = await h.call<{ chars: number }>('POST', 'long-videos/' + taskId + '/extend-script')
    expect(res.code, String(res.message)).toBe(0)
    expect(prompts.join('\n'), '稿件提示词里要带上用户资料').toContain('三层复合')
    const sample = samples().find(item => item.sourceId === 'long-video-script-' + taskId)
    expect(sample, '拿得到任务 id 就按任务 id 留痕（能查出这条稿属于哪条任务）').toBeDefined()
    expect(sample!.task).toBe('video')
    expect(sample!.knowledgePaths).toContain('探针资料：产品卖点.md')
  })

  it('这次没达标也留痕：账本记的是「模型产出了什么」，不是「这次有没有达标」', async () => {
    const taskId = 'lv-trace-2'
    seedTask(taskId, 30)
    reply = '露营地垫很轻便。'
    const res = await h.call('POST', 'long-videos/' + taskId + '/extend-script')
    // 产品规则如实拒绝（补写后仍不足字数），但这不影响"这次调用发生过、产出了什么"被记下来。
    expect(res.code, '不足字数是如实拒绝，不是静默成功').not.toBe(0)
    expect(String(res.message)).toContain('不足')
    const sample = samples().find(item => item.sourceId === 'long-video-script-' + taskId)
    expect(sample, '被产品拒绝的产出同样是"这一轮真实发生过的事"').toBeDefined()
    expect(sample!.instruction, '提示词也留着，事后能回放当时问了什么').toContain('露营地垫')
  })
})
