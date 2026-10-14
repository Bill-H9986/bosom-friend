#!/usr/bin/env node
/**
 * 探针：**模型实际拿到的工具清单**（读真实模型请求体，不看配置推断）。
 *
 * 为什么必须有它：工具面收敛（把 pwsh / 文件读写 / subagent 这些编码智能体工具拿掉）
 * 当初只靠一次人工看请求体验证过，**没有可重复的门禁**——它挡的是"模型在客户的 Windows 上
 * 执行命令"这一类风险，却没有任何东西在下次有人改补丁层时判红。
 *
 * 顺带它也验另一件事（DEF-155 的预防层）：置 BF_TEXT_ONLY=1 时内核**一个工具都不该挂**，
 * 这样"纯文本生成"这条路根本不具备调工具的可能。
 *
 * 运行：
 *   node --import tsx/esm products/bosom-friend/qa/probes/probe-effective-tools.mjs
 *   BF_TEXT_ONLY=1 node --import tsx/esm ...（同一脚本，验预防层）
 * 退出码：0 = 两项断言都过；1 = 有断言不过。
 */
import { startMockLlmServer } from '../../../../packages/test-support/llm-mock-server/src/index.ts'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
// 本探针住在 products/bosom-friend/qa/probes/：三层 dirname 到 products/bosom-friend，再上两级才是仓库根
// （与 probe-agent-instructions.mjs 同一算法——它跑得通，别自己另发明一套）。
const launcherDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const repoRoot = resolve(launcherDir, '..', '..')
const tempHome = mkdtempSync(join(tmpdir(), 'bf-probe-tools-'))
/** 编码智能体工具的痕迹：这些一旦出现在模型请求里就是回归（面向消费者的桌面 APP）。 */
const FORBIDDEN = ['pwsh', 'shell', 'read_file', 'write_file', 'edit_file', 'subagent', 'workflow', 'ralph', 'todo_write']
const textOnly = process.env.BF_TEXT_ONLY === '1'

const mock = await startMockLlmServer({
  port: 0,
  apiKey: 'mock-key',
  sequence: ['success'],
  repeatLast: true,
  successText: '收到',
})

const client = new HarnessClient({
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

const client2 = client
const subscription = client2.subscribe()
const consume = (notification) => {
  if (typeof notification !== 'object' || notification === null) return
  void notification
}

let toolNames = []
let ok = false
try {
  await client2.initialize({ cwd: repoRoot, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await client2.prompt('probe-' + Date.now(), [{ type: 'text', text: '请只回复：收到' }])
  const deadline = Date.now() + 60000
  while (mock.requests.length === 0 && Date.now() < deadline) {
    const next = subscription.tryNext()
    if (next !== undefined) consume(next)
    else await new Promise((r) => setTimeout(r, 100))
  }
  const body = mock.requests[0]?.body ?? {}
  const tools = Array.isArray(body.tools) ? body.tools : []
  toolNames = tools.map((tool) => String(tool?.function?.name ?? tool?.name ?? '')).filter((name) => name !== '')
  const dump = join(here, textOnly ? '.probe-tools-textonly.json' : '.probe-tools.json')
  writeFileSync(dump, JSON.stringify(toolNames, null, 2), 'utf8')

  const leaked = toolNames.filter((name) => FORBIDDEN.some((bad) => name.toLowerCase().includes(bad)))
  const hasBosom = toolNames.some((name) => name.startsWith('bosom_'))

  if (textOnly) {
    ok = toolNames.length === 0
    console.log('TEXT_ONLY_TOOLS=' + String(toolNames.length))
    console.log(ok ? 'TEXT_ONLY_NO_TOOLS_OK' : 'TEXT_ONLY_NO_TOOLS_FAIL 仍然挂着：' + toolNames.join(', '))
  }
  else {
    ok = leaked.length === 0 && hasBosom
    console.log('TOOL_COUNT=' + String(toolNames.length))
    console.log('TOOLS=' + toolNames.join(', '))
    console.log(leaked.length === 0 ? 'TOOL_CONVERGENCE_OK' : 'TOOL_CONVERGENCE_FAIL 不该出现的工具：' + leaked.join(', '))
    console.log(hasBosom ? 'BOSOM_TOOLS_PRESENT' : 'BOSOM_TOOLS_MISSING')
  }
  console.log('BODY_DUMP=' + dump)
}
catch (error) {
  console.log('PROBE_FAIL ' + (error instanceof Error ? error.message : String(error)))
  ok = false
}
finally {
  await client2.close().catch(() => {})
  await mock.close?.().catch?.(() => {})
  rmSync(tempHome, { recursive: true, force: true })
}
process.exit(ok ? 0 : 1)
