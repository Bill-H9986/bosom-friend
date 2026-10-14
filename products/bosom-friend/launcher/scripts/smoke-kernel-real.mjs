#!/usr/bin/env node
/**
 * 官方内核真实模型冒烟（用用户自己的 Agnes 网关）：
 * 客户端 → 内核运行时 → 官方 llm-pi-ai 适配器 → Agnes 模型 → 流式回传。
 * 密钥只经本机 .env 传入子进程，不写入任何仓库文件；数据根用临时目录隔离。
 */
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const launcherDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(launcherDir, '..', '..', '..')
process.loadEnvFile(join(repoRoot, '.env'))

if (!process.env.AGNES_API_KEY) {
  console.error('REAL_MODEL_NO_KEY 缺少 AGNES_API_KEY（本机 .env）')
  process.exit(2)
}

const tempHome = mkdtempSync(join(tmpdir(), 'bf-kernel-real-'))

const client = new HarnessClient({
  command: process.execPath,
  args: ['products/bosom-friend/launcher/lib/bin-kernel.mjs'],
  cwd: repoRoot,
  env: {
    ...process.env,
    BOSOM_FRIEND_HOME: tempHome,
    DSH_PERMISSION_MODE: 'danger-full-access',
  },
})

const subscription = client.subscribe()
let collected = ''
let sawToolCall = false
const consume = (notification) => {
  if (typeof notification !== 'object' || notification === null) return
  if (notification.method !== 'session.event') return
  const event = notification.params?.event
  if (typeof event !== 'object' || event === null) return
  if (event.type === 'tool/call' || event.type === 'tool/result') sawToolCall = true
  if (event.type !== 'assistant/chunk') return
  const chunk = event.data?.chunk
  if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') collected += chunk.text
  if (typeof chunk?.delta === 'string') collected += chunk.delta
}

let failed = false
try {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.initialize({ cwd: repoRoot, provider: 'agnes', model: 'agnes-2.5-flash' })
      break
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('no adapter registered') || attempt === 2) throw error
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
    }
  }
  await client.prompt('smoke-real-' + Date.now(), [{ type: 'text', text: '请只回复：真实模型正常' }])
  const deadline = Date.now() + 120000
  while (!collected.includes('真实模型正常') && Date.now() < deadline) {
    const next = subscription.tryNext()
    if (next !== undefined) consume(next)
    else await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  if (collected.includes('真实模型正常')) {
    console.log('KERNEL_REAL_OK text=' + JSON.stringify(collected) + ' toolCall=' + sawToolCall)
  } else {
    failed = true
    console.log('KERNEL_REAL_UNEXPECTED text=' + JSON.stringify(collected) + ' toolCall=' + sawToolCall)
  }
  collected = ''
  await client.prompt('smoke-tool-' + Date.now(), [
    { type: 'text', text: '请调用工具 bosom_kernel_ping，参数 message 填 hello-kernel，然后把工具返回结果告诉我。' },
  ])
  const toolDeadline = Date.now() + 120000
  while (!sawToolCall && Date.now() < toolDeadline) {
    const next = subscription.tryNext()
    if (next !== undefined) consume(next)
    else await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  if (sawToolCall) {
    console.log('KERNEL_TOOL_CALL_OK modelDrivenTool=true')
  } else {
    failed = true
    console.log('KERNEL_TOOL_CALL_MISSING modelDrivenTool=false')
  }
  collected = ''
  sawToolCall = false
  await client.prompt('smoke-gen-' + Date.now(), [
    {
      type: 'text',
      text: '请调用工具 bosom_content_generate_script，参数 prompt 填“用一句话介绍无人机装调检修就业培训”，kind 填 image-text，save 填 false，然后把返回的标题告诉我。',
    },
  ])
  const genDeadline = Date.now() + 120000
  while ((!sawToolCall || collected === '') && Date.now() < genDeadline) {
    const next = subscription.tryNext()
    if (next !== undefined) consume(next)
    else await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  if (sawToolCall && collected !== '') {
    console.log('KERNEL_GENERATE_OK collected=' + JSON.stringify(collected.slice(0, 80)))
  } else {
    failed = true
    console.log('KERNEL_GENERATE_MISSING toolCall=' + sawToolCall + ' collected=' + JSON.stringify(collected.slice(0, 80)))
  }
} catch (error) {
  failed = true
  console.error('KERNEL_REAL_FAIL ' + (error instanceof Error ? error.message : String(error)))
} finally {
  subscription.close()
  await client.close()
  rmSync(tempHome, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
