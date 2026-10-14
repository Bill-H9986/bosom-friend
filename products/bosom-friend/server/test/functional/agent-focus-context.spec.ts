import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import { buildFocusContext, parseAgentFocus } from '../../src/agent-context.ts'

/**
 * 助手必须知道用户此刻在看哪一条（ADR-004 S1，飞书那一侧的"对象即上下文"）。
 *
 * 为什么锁这一条：这是"助手是另一个世界"与"助手在工作现场"的分界线。
 * 判据不是"服务端收到了 focus 字段"，而是**送进内核的那段提示词里有没有这个对象的特征**——
 * 字段收了但没进上下文，等于没做。
 *
 * 另外两件必须钉住的语义：① 没有 focus 时不能凭空出现一个对象；
 * ② 焦点是**每轮**的（第二轮换了对象，提示词里就得换）——写进会话基线就做不到了。
 */

const prompts: string[] = []

vi.mock('../../src/kernel-client.ts', async () => ({
  // 解析函数用真实实现：桩掉内核不等于可以把对话稿也换成空实现。
  ...(({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  ),
  createKernelClient: () => ({
    prompt: async (prompt: string, onDelta?: (text: string) => void) => {
      prompts.push(prompt)
      const text = '好的。'
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

/** 发一轮对话；focus 为 undefined 表示不带焦点。 */
async function say(prompt: string, focus?: Record<string, unknown>, taskId?: string): Promise<string> {
  const res = await h.call<{ taskId?: string }>('POST', 'agent/tasks', {
    body: { prompt, includePartialMessages: true, ...focus === undefined ? {} : { focus }, ...taskId === undefined ? {} : { taskId } },
  })
  const init = res.sse.find(frame => frame.type === 'init')
  return String(init?.taskId ?? '')
}

const DRAFT_FOCUS = {
  page: '内容创作',
  objectKind: '草稿',
  objectId: 'dft-9527',
  title: '夏日特调上新',
  excerpt: '第一句：把柠檬气泡水写成夏天的主角。',
}

describe('焦点对象：页面正在看的那一条，进的是每一轮的上下文', () => {
  it('带着草稿提问，提示词里出现这条草稿的标题与内容', async () => {
    prompts.length = 0
    await say('这条怎么改？', DRAFT_FOCUS)
    const sent = prompts[prompts.length - 1]!
    expect(sent).toContain('夏日特调上新')
    expect(sent).toContain('把柠檬气泡水写成夏天的主角')
    expect(sent).toContain('用户正在看的对象')
  })

  it('没带焦点时，提示词里不会凭空出现对象块', async () => {
    prompts.length = 0
    await say('你好。')
    expect(prompts[prompts.length - 1]!).not.toContain('用户正在看的对象')
  })

  it('同一段对话里换了对象，第二轮送的是新的那一条', async () => {
    prompts.length = 0
    const taskId = await say('这条怎么改？', DRAFT_FOCUS)
    await say('那这条呢？', { ...DRAFT_FOCUS, objectId: 'dft-2', title: '周末露营清单' }, taskId)
    const second = prompts[prompts.length - 1]!
    expect(second).toContain('周末露营清单')
    expect(second, '第二轮不该再带上一轮那条的对象名').not.toContain('夏日特调上新')
    expect(second, '第二轮仍然只有本轮这一句（历史在会话里）').toContain('那这条呢')
  })
})

describe('焦点的解析与渲染：只认页面给的事实，不猜不补', () => {
  it('认不出页面就当没有焦点', () => {
    expect(parseAgentFocus(undefined)).toBeUndefined()
    expect(parseAgentFocus('内容创作')).toBeUndefined()
    expect(parseAgentFocus({ objectKind: '草稿' })).toBeUndefined()
  })

  it('非字符串字段按空串处理，不把对象塞进上下文', () => {
    const focus = parseAgentFocus({ page: '内容创作', title: 42, excerpt: null })
    expect(focus).toEqual({ page: '内容创作', objectKind: '', objectId: '', title: '', excerpt: '' })
  })

  it('超长摘要被截断，不会把整篇正文顶进提示词', () => {
    const focus = parseAgentFocus({ page: '内容创作', excerpt: 'x'.repeat(5000) })
    expect(focus?.excerpt.length).toBe(600)
  })

  it('只知道页面时也说得清"他在哪一页"', () => {
    const block = buildFocusContext({ page: '数据中心', objectKind: '', objectId: '', title: '', excerpt: '' })
    expect(block).toContain('- 页面：数据中心')
    expect(block, '没有具体对象时不要留一行空的"正在看的对象"').not.toContain('- 正在看的对象：')
  })
})
