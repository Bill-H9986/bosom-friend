import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { JsonFile } from '../../src/store.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 纯文本任务不许调工具——调了就**整份产出作废**（DEF-155）。
 *
 * 为什么必须在**这一层**拦：内核会话是带工具的（api.ts 里 TEXT_ONLY_GUARD 的注释自己写着），
 * 提示词拦不住模型的时候，最终正文就是一段**工具驱动的对话回复**。真机实测（2026-09-22）：
 * 「AI 改标题」把「抱歉，当前草稿箱里没有「…」这条记录」写成了草稿标题，而接口回的是 code=0——
 * 用户看到的是一次"成功"，内容却是一句对话。
 *
 * 判据看两件事：**该拒的必须一个字都不写**，以及**不该拒的正常写回**（否则就是把生成能力整个关掉了）。
 */

/** 这一轮"模型"会不会先去调工具。 */
let callsTool = false
/** 这一轮模型给的正文。 */
let reply = '正常的标题'

vi.mock('../../src/kernel-client.ts', async () => ({
  ...((({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  )),
  createKernelClient: () => ({
    prompt: async (_prompt: string, onDelta?: (text: string) => void, _abort?: unknown, onStep?: (step: unknown) => void) => {
      if (callsTool) {
        onStep?.({ kind: 'tool-call', call: { callId: 'call-1', name: 'bosom_content_list_drafts', arguments: '{}' } })
        onStep?.({ kind: 'tool-result', result: { callId: 'call-1', content: '草稿箱里没有这条记录', isError: false } })
        onDelta?.('抱歉，当前草稿箱里没有这条记录')
        return { text: '抱歉，当前草稿箱里没有这条记录' }
      }
      onDelta?.(reply)
      return { text: reply }
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

/** 建一条草稿并跑一次「AI 改标题」。 */
async function createDraft(title: string): Promise<string> {
  const created = await h.call<{ _id?: string }>('POST', 'contents/drafts', {
    body: { groupId: 'mg-persist', title, desc: '正文先放这儿', mediaList: [] },
  })
  return String(created.data?._id ?? '')
}

/** 读回草稿标题。 */
async function readTitle(id: string): Promise<string> {
  const res = await h.call<{ title?: string }>('GET', 'contents/' + id)
  return String(res.data?.title ?? '')
}

/** 读回账本样本的 sourceId 集合。 */
function sampleSources(): string[] {
  const file = h.dataRoot + '/knowledge.json'
  const knowledge = new JsonFile<{ distillations?: Array<{ sourceId: string }> }>(
    file,
    () => ({ notes: {}, vault: { path: '', builtIn: true } }),
  ).load()
  return (knowledge.distillations ?? []).map(item => item.sourceId)
}

describe('纯文本任务调了工具：产出整份作废', () => {
  it('模型去查数据了 → 一个字都不写回，并如实说清原因', async () => {
    callsTool = true
    const id = await createDraft('原标题不该被覆盖')
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })
    expect(res.code, '不能报成功').not.toBe(0)
    expect(String(res.message), '原因要说人话').toContain('调工具')
    expect(await readTitle(id), '用户内容一个字都不能动').toBe('原标题不该被覆盖')
    // 诊断必须真的落盘：这条日志原本排在"文本为空就返回"之后，于是**永远不会执行**——
    // 真机复核时才发现（2026-09-22）。判据就是不让它再悄悄失效。
    const logged = new JsonFile<Array<{ kind: string }>>(h.dataRoot + '/ai-logs.json', () => []).load()
    expect(logged.some(item => item.kind === 'object_action_tool_call'), '调工具的这一步要留诊断').toBe(true)
  })

  it('没有调工具时照常写回（别把生成能力一起关掉）', async () => {
    callsTool = false
    reply = '正常改写出来的标题'
    const id = await createDraft('旧标题')
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })
    expect(res.code, String(res.message)).toBe(0)
    expect(await readTitle(id)).toBe('正常改写出来的标题')
  })

  it('翻车这一轮不记账本：失败不该成为"成功样例"', async () => {
    callsTool = true
    const before = sampleSources()
    const id = await createDraft('又一条原标题')
    await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })
    const added = sampleSources().filter(source => !before.includes(source))
    expect(added, '被丢弃的产出不能进账本').toHaveLength(0)
  })
})
