#!/usr/bin/env node
/**
 * 探针：官方上下文通道 `dsh-agent-instructions` 是否把 `$DSH_HOME/AGENTS.md`
 * 注入产品内核会话（只读诊断，非门禁）。
 *
 * 为什么需要它：ADR-003 口径二要求"产品规则经官方上下文通道注入，而不是字符串拼接"，
 * 而 `DSH_HOME` 被 bin-kernel.ts 设成产品根。通道是否真的读到那份文件，
 * 只能靠"模型真实收到的那份请求体"来证明，不能靠配置推断。
 *
 * 运行：node --import tsx/esm products/bosom-friend/qa/probes/probe-agent-instructions.mjs
 * 退出码：0 = 标记出现在模型请求里；1 = 没有出现。
 */
// 走相对路径而不是裸包名：本探针住在 qa/probes/，那里解析不到 test-support 的 workspace 包。
import { startMockLlmServer } from '../../../../packages/test-support/llm-mock-server/src/index.ts'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// 用产品**自己生成**的语境文件，而不是手写的占位符：这样探针验的是真实链路
// （agent-rules.ts → 语境文件 → 官方上下文通道 → 模型请求），而不是"通道能读文件"这一件事。
import { buildAgentContext, writeAgentContext } from '../../server/src/agent-context.ts'
import { writeSkill } from '../../server/src/agent-skills.ts'

const MARKER = 'BOSOM_DOMAIN_MARKER_7F3A9C'
/** 只在 AGENT_RULES 里出现的一句身份话（产品规则确实到了模型那里才算通过）。 */
const RULES_PHRASE = 'Bosom Friend 的 APP 智能体'
/** 技能名与技能正文里的独有串：用来判断"升格出来的技能有没有到模型手里"。 */
const SKILL_NAME = 'probe-skill-name'
const SKILL_BODY_PHRASE = 'BOSOM_SKILL_BODY_9C1F'
const launcherDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
// 本探针住在 products/bosom-friend/qa/probes/：三层 dirname 到 products/bosom-friend，再上两级才是仓库根。
const repoRoot = resolve(launcherDir, '..', '..')
const tempHome = mkdtempSync(join(tmpdir(), 'bf-probe-instr-'))

// 用户全局指令文件：官方通道读的就是这一份（$DSH_HOME/AGENTS.md）。
// 先写一段"用户自己写的"内容，再让产品把它接管进自动区块——两者都要在模型请求里活着。
writeFileSync(join(tempHome, 'AGENTS.md'), MARKER + '：用户自己写在区块外的内容。\n', 'utf8')
writeAgentContext(tempHome, buildAgentContext({
  platforms: ['小红书'],
  recentFailures: [],
  successSamples: 0,
  ratedSamples: 0,
}))

// 技能：写进官方技能通道扫描的 <dshHome>/skills。技能是**按需加载**的，
// 所以正文不一定进请求体——但技能目录（名字与说明）应当让模型看得见，否则它永远挑不到。
writeSkill(tempHome, {
  slug: 'skill-probe',
  name: SKILL_NAME,
  description: 'BOSOM_SKILL_DESC_4E2A：这是探针写的一个技能',
  whenToUse: '当探针需要验证技能目录时',
  body: SKILL_BODY_PHRASE + '\n1. 一步\n2. 两步',
})

const mock = await startMockLlmServer({
  port: 0,
  apiKey: 'mock-key',
  sequence: ['success'],
  repeatLast: true,
  successText: '收到',
})

const client = new HarnessClient({
  // 与 server/src/kernel-client.ts 的启动契约逐字一致：dshBin 指向产品内核入口，
  // profile 报同一个名字。**不能用 command/args** —— 那不是 HarnessClient 的选项，
  // 传了会被忽略，实际启起来的是通用 sdk profile（探针第一版就踩了这个坑）。
  dshBin: resolve(repoRoot, process.env.BF_PROBE_ENTRY ?? 'products/bosom-friend/bundle/kernel/runtime/bin-kernel.mjs'),
  profile: 'bosom-friend-kernel',
  processCwd: repoRoot,
  env: {
    ...process.env,
    DEEPSEEK_BASE_URL: mock.baseURL,
    DEEPSEEK_API_KEY: 'mock-key',
    DSH_PERMISSION_MODE: 'danger-full-access',
    BOSOM_FRIEND_HOME: tempHome,
  },
})

const subscription = client.subscribe()
const eventTypes = new Set()
const consume = (notification) => {
  if (typeof notification !== 'object' || notification === null) return
  if (notification.method !== 'session.event') return
  const type = notification.params?.event?.type
  if (typeof type === 'string') eventTypes.add(type)
}

let ok = false
try {
  await client.initialize({ cwd: repoRoot, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await client.prompt('probe-' + Date.now(), [{ type: 'text', text: '请只回复：收到' }])
  const deadline = Date.now() + 60000
  while (mock.requests.length === 0 && Date.now() < deadline) {
    const next = subscription.tryNext()
    if (next !== undefined) consume(next)
    else await new Promise((r) => setTimeout(r, 100))
  }
  // 请求可能分多轮（工具调用），把每一轮的请求体都搜一遍。
  const bodies = mock.requests.map((record) => JSON.stringify(record.body ?? ''))
  const hit = bodies.find((body) => body.includes(MARKER))
  const rulesHit = bodies.find((body) => body.includes(RULES_PHRASE))
  const skillNameHit = bodies.find((body) => body.includes(SKILL_NAME))
  const skillBodyHit = bodies.find((body) => body.includes(SKILL_BODY_PHRASE))
  ok = hit !== undefined && rulesHit !== undefined
  console.log('SKILL_CATALOG=' + (skillNameHit === undefined ? 'MISSING' : 'OK') + ' SKILL_BODY=' + (skillBodyHit === undefined ? 'MISSING' : 'IN_REQUEST'))
  console.log('MOCK_REQUESTS=' + mock.requests.length)
  console.log('SESSION_EVENT_TYPES=' + [...eventTypes].sort().join(','))
  console.log(rulesHit === undefined ? 'RULES_CHANNEL_MISSING' : 'RULES_CHANNEL_OK')
  // 落盘完整请求体：模型到底收到什么，只能看这份原件。
  const dump = join(dirname(fileURLToPath(import.meta.url)), '.probe-body.json')
  writeFileSync(dump, JSON.stringify(mock.requests.map((r) => r.body ?? null), null, 2), 'utf8')
  console.log('BODY_DUMP=' + dump)
  if (ok) {
    const at = hit.indexOf(MARKER)
    console.log('INSTRUCTION_CHANNEL_OK')
    console.log('CONTEXT_AROUND_MARKER=' + hit.slice(Math.max(0, at - 220), at + 120))
  } else {
    console.log('INSTRUCTION_CHANNEL_MISSING')
    console.log('FIRST_BODY_HEAD=' + (bodies[0] ?? '(no request)').slice(0, 700))
  }
} catch (error) {
  console.log('PROBE_FAIL ' + (error instanceof Error ? error.message : String(error)))
} finally {
  subscription.close()
  await client.close()
  await mock.close()
  rmSync(tempHome, { recursive: true, force: true })
}
process.exit(ok ? 0 : 1)
