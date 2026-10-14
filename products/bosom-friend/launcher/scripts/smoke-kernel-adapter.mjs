#!/usr/bin/env node
/**
 * 生产适配层冒烟（真实模型）：直接调用 server/src/kernel-client.ts 的
 * createKernelClient（BYOK 路径），验证生产代码里的内核客户端能跑通。
 * 密钥来自本机 .env；数据根用临时目录隔离。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKernelClient } from '../../../bosom-friend/server/src/kernel-client.ts'

const launcherDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(launcherDir, '..', '..', '..')
process.loadEnvFile(join(repoRoot, '.env'))
const apiKey = process.env.AGNES_API_KEY
if (!apiKey) {
  console.error('ADAPTER_NO_KEY 缺少 AGNES_API_KEY（本机 .env）')
  process.exit(2)
}

const tempHome = mkdtempSync(join(tmpdir(), 'bf-kernel-adapter-'))
const previousHome = process.env.BOSOM_FRIEND_HOME
process.env.BOSOM_FRIEND_HOME = tempHome
const kernel = createKernelClient({
  provider: 'agnes',
  model: 'agnes-2.5-flash',
  baseUrl: 'https://api.agnes-ai.cn/v1',
  apiKey,
})

let failed = false
try {
  const out = await kernel.prompt('请只回复：生产适配正常')
  if (out.error === undefined && out.text.includes('生产适配正常')) {
    console.log('ADAPTER_OK text=' + JSON.stringify(out.text))
  } else {
    failed = true
    console.log('ADAPTER_UNEXPECTED ' + JSON.stringify(out))
  }
} catch (error) {
  failed = true
  console.error('ADAPTER_FAIL ' + (error instanceof Error ? error.message : String(error)))
} finally {
  await kernel.close()
  if (previousHome === undefined) delete process.env.BOSOM_FRIEND_HOME
  else process.env.BOSOM_FRIEND_HOME = previousHome
  rmSync(tempHome, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
