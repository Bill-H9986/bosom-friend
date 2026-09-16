#!/usr/bin/env node
/**
 * 内核会话端到端冒烟（免真实 Key，使用官方模拟模型服务器）：
 * 客户端 → 内核运行时（官方适配器）→ 模拟模型 → session.event 流式回传 → 客户端聚合。
 * 运行：node --import tsx/esm products/bosom-friend/launcher/scripts/smoke-kernel-session.mjs
 */
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server/src/index.ts'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launcherDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(launcherDir, '..', '..', '..')
const tempHome = mkdtempSync(join(tmpdir(), 'bf-kernel-session-'))

const mock = await startMockLlmServer({
  port: 0,
  apiKey: 'mock-key',
  sequence: ['success'],
  repeatLast: true,
  successText: '内核会话链路正常',
})

const client = new HarnessClient({
  command: process.execPath,
  args: ['products/bosom-friend/launcher/lib/bin-kernel.mjs'],
  cwd: repoRoot,
  env: {
    ...process.env,
    DEEPSEEK_BASE_URL: mock.baseURL,
    DEEPSEEK_API_KEY: 'mock-key',
    DSH_PERMISSION_MODE: 'danger-full-access',
    BOSOM_FRIEND_HOME: tempHome,
  },
})

const subscription = client.subscribe()
let collected = ''
const seenTypes = new Set()
let lastTurnEnd = ''
const chunkSamples = new Map()
const consume = (notification) => {
  if (typeof notification !== 'object' || notification === null) return
  seenTypes.add(notification.method)
  if (notification.method !== 'session.event') return
  const event = notification.params?.event
  if (typeof event !== 'object' || event === null) return
  seenTypes.add('session.event:' + event.type)
  if (event.type === 'turn/end') lastTurnEnd = JSON.stringify(event).slice(0, 500)
  if (event.type === 'assistant/chunk') {
    const chunk = event.data?.chunk
    const chunkType = chunk?.type ?? 'unknown'
    if (!chunkSamples.has(chunkType)) chunkSamples.set(chunkType, JSON.stringify(chunk).slice(0, 160))
    if (typeof chunk?.text === 'string') collected += chunk.text
    if (typeof chunk?.delta === 'string') collected += chunk.delta
  }
  if (event.type !== 'assistant/chunk') return
}

let failed = false
try {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.initialize({ cwd: repoRoot, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
      break
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('no adapter registered') || attempt === 2) throw error
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
    }
  }
  await client.prompt('smoke-session-' + Date.now(), [{ type: 'text', text: '请只回复：内核会话链路正常' }])
  const deadline = Date.now() + 90000
  while (collected === '' && Date.now() < deadline) {
    const next = subscription.tryNext()
    if (next !== undefined) consume(next)
    else await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  if (collected.includes('内核会话链路正常')) {
    console.log(`KERNEL_SESSION_OK collected=${JSON.stringify(collected)}`)
  } else {
    failed = true
    console.log(`KERNEL_SESSION_EMPTY collected=${JSON.stringify(collected)}`)
  }
} catch (error) {
  failed = true
  console.error('KERNEL_SESSION_FAIL ' + (error instanceof Error ? error.message : String(error)))
} finally {
  console.log(`KERNEL_DIAG mockRequests=${mock.requests.length} chunks=${[...chunkSamples.entries()].map(([k, v]) => k + '=' + v).join(' | ')} turnEnd=${lastTurnEnd}`)
  subscription.close()
  await client.close()
  await mock.close()
  rmSync(tempHome, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
