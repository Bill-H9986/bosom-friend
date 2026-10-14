import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 产品规则走**官方上下文通道**，不再每轮拼进提示词（ADR-003 口径二）。
 *
 * 为什么值得单独锁一条：这是"模型看到的产品规则从哪里来"的唯一分界线。
 * 换错方向有两种坏法——规则既在提示词里又在文件里（重复、两处会漂移），
 * 或者两头都没有（模型彻底失去身份与红线，而且**不会报错**，只会答得越来越离谱）。
 * 所以正反两面都要断言：提示词里没有，文件里有。
 */

const prompts: string[] = []

vi.mock('../../src/kernel-client.ts', async () => ({
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

/** 规则里的一句身份话：只有 AGENT_RULES 才有。 */
const IDENTITY = 'Bosom Friend 的 APP 智能体'

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

describe('产品规则：从每轮提示词搬到官方上下文通道', () => {
  it('提示词里不再出现产品规则（它不该每轮重发）', async () => {
    prompts.length = 0
    await h.call('POST', 'agent/tasks', { body: { prompt: '你好。', includePartialMessages: true } })
    const sent = prompts[prompts.length - 1]!
    expect(sent, '规则不该再拼进这一轮的用户输入').not.toContain(IDENTITY)
    expect(sent, '用户那一句还要在里面').toContain('你好')
  })

  it('稳定语境文件里有产品规则全文，标签齐全', () => {
    // 数据根的上一级就是内核的 DSH_HOME（bin-kernel.ts 把 DSH_HOME 设成产品根）。
    const file = join(dirname(h.dataRoot), 'AGENTS.md')
    expect(existsSync(file), '建路由表时就该写好这份文件（服务启动期，早于任何请求）').toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(IDENTITY)
    expect(text).toContain('## 领域语境（产品规则全文）')
    expect(text, '四类语境里的约束语境也在同一份文件里').toContain('## 约束语境')
    expect(text).toContain('# 十、红线（绝对禁止）')
  })

  it('自动区块只出现一次（重复刷新不堆叠）', () => {
    const text = readFileSync(join(dirname(h.dataRoot), 'AGENTS.md'), 'utf8')
    expect(text.split('<!-- BOSOM-FRIEND-CONTEXT:BEGIN -->')).toHaveLength(2)
    expect(text.split('<!-- BOSOM-FRIEND-CONTEXT:END -->')).toHaveLength(2)
  })
})
