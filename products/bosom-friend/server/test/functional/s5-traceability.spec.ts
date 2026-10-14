import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonFile } from '../../src/store.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import type { KnowledgeState } from '../../src/knowledge-distill.ts'

/**
 * S5：**每一次模型调用都带上下文、都留痕**（ADR-004 的「三大核心全接入」）。
 *
 * 这一条不能靠"读代码觉得接上了"来宣称：这个项目反复栽在同一处——**函数写好了、没人调它**，
 * 或者"账本记了上下文，但提示词里其实没带"。所以判据看两件事：
 * ① 截下**真正送进内核的提示词**，断言这一路该带的语境确实在里面；
 * ② 账本里留下一条样本，且带着"这次用了什么"的度量（知识命中了哪几篇、用了哪几条成功样例）。
 */

/** 每一次调用真正送进内核的提示词。 */
const prompts: string[] = []
let reply = '这是模型给出的一段内容'

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
function samples(): Array<{
  sourceId: string
  task: string
  knowledgePaths: string[]
  knowledgeChars: number
  exampleIds?: string[]
  rating: number
}> {
  const knowledge = new JsonFile<KnowledgeState>(h.dataRoot + '/knowledge.json', knowledgeDefault).load()
  return (knowledge.distillations ?? []) as never
}

/** 知识库里放一篇"只有我们产品才有"的资料：模型带上它才答得准。 */
function seedKnowledge(): void {
  const file = h.dataRoot + '/knowledge.json'
  const knowledge = new JsonFile<KnowledgeState>(file, knowledgeDefault).load()
  knowledge.notes = {
    '产品资料.md': {
      name: '产品资料',
      content: '# 发货与售后\n\n现货 48 小时内发出，偏远地区顺丰加收 15 元；\n七天无理由，拆封后只换不退。\n',
    },
  }
  new JsonFile<KnowledgeState>(file, knowledgeDefault).save(knowledge)
}

beforeAll(async () => {
  h = createHarness()
  seedKnowledge()
  // 清掉内置接待规则：本用例要验的是**模型那一条路**，而内置规则会先把常见问题接走
  // （第一版就是这么红的：aiUsed=false，模型根本没被调用）。
  new JsonFile<unknown[]>(h.dataRoot + '/reception-rules.json', () => []).save([])
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

beforeEach(() => {
  prompts.length = 0
})

describe('接待建议：带着你自己的知识回答客人，并留下一条样本', () => {
  it('知识库里的资料真的进了提示词，账本也记下了命中了哪几篇', async () => {
    reply = '现货 48 小时内发出，偏远地区顺丰加收 15 元。'
    const res = await h.call<{ reply: string, aiUsed: boolean }>('POST', 'v2/customer-reception/suggest', {
      body: { message: '你们一般什么时候发货？偏远地区怎么算运费？', platform: 'xhs', accountId: 'acc-1' },
    })
    expect(res.code, String(res.message)).toBe(0)
    expect(res.data.aiUsed, '没有命中规则时要走模型').toBe(true)

    // ① 语境真的到了模型：提示词里有知识库原文里的数字。
    const prompt = prompts.join('\n')
    expect(prompt, '提示词里要带上知识库原文').toContain('48 小时内发出')
    expect(prompt, '也要带上资料里的其它约束').toContain('七天无理由')

    // ② 留痕：账本里有这一条，并记下命中了哪几篇知识。
    const sample = samples().find(item => item.sourceId.startsWith('reception-suggest-'))
    expect(sample, '每一次模型调用都要留一条样本').toBeDefined()
    expect(sample!.task).toBe('chat')
    expect(sample!.knowledgePaths, '注入了哪些知识要入账').toContain('产品资料.md')
    expect(sample!.knowledgeChars).toBeGreaterThan(0)
  })

  it('同一句话重复问不会把账本撑爆（来源 id 是内容寻址的）', async () => {
    const before = samples().filter(item => item.sourceId.startsWith('reception-suggest-')).length
    await h.call('POST', 'v2/customer-reception/suggest', {
      body: { message: '你们一般什么时候发货？偏远地区怎么算运费？', platform: 'xhs', accountId: 'acc-1' },
    })
    const after = samples().filter(item => item.sourceId.startsWith('reception-suggest-')).length
    expect(after, '同样的平台/账号/来访原文 → 覆盖同一条，不新增').toBe(before)
  })
})

describe('对象动作与助手：同样看得到"这次用了什么"', () => {
  it('对象动作写下样本，并带上对象身份（后续要用它跟发布记录对账）', async () => {
    const created = await h.call<{ _id?: string }>('POST', 'contents/drafts', {
      body: { groupId: 'mg-persist', title: '夏日特调', desc: '三种在家就能做的夏日特调', mediaList: [] },
    })
    const id = String(created.data?._id ?? '')
    reply = '夏日特调 3.0 上新'
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })
    expect(res.code, String(res.message)).toBe(0)

    const sample = samples().find(item => item.sourceId === 'object-action-draft-' + id + '-draft-title')
    expect(sample, '对象动作要留样本').toBeDefined()
    expect(sample!.task).toBe('chat')
    expect(prompts.join('\n'), '动作提示词本身也在里面').toContain('夏日特调')
  })

  it('助手对话：样本记下这一次注入了哪些知识与样例', async () => {
    reply = '现货 48 小时内发出。'
    // 问法要真的落在资料里：检索阈值是"命中 3 个检索词"（标题命中记 2），
    // 而中文按 2 字滑窗提词——"发货时间"这种问法在本例的资料里一个词都算不上命中。
    await h.call('POST', 'agent/tasks', {
      body: { prompt: '客户问什么时候发货、偏远地区运费怎么算，我该怎么答？', includePartialMessages: true },
    })
    const chat = samples().filter(item => item.task === 'chat' && item.sourceId.startsWith('task-'))
    expect(chat.length, '助手每一轮都留样本').toBeGreaterThan(0)
    expect(chat.some(item => item.knowledgePaths.length > 0), '命中知识的那一轮要记下来').toBe(true)
  })
})
