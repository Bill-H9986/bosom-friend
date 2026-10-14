#!/usr/bin/env node
/**
 * 内核入口冒烟：用官方 dsh-sdk-client 的 HarnessClient 按 profile 契约启动 bin-kernel.mjs，
 * 完成 initialize 握手后按协议 shutdown。只验证组合链路，不发起模型调用（无需 API Key）。
 */
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const launcherDir = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(launcherDir, '..', '..', '..')

const client = new HarnessClient({
  dshBin: resolve(repoRoot, 'products/bosom-friend/launcher/lib/bin-kernel.mjs'),
  profile: 'bosom-friend-kernel',
  processCwd: repoRoot,
})

let failed = false
try {
  const info = await client.initialize({
    cwd: repoRoot,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  console.log('KERNEL_INITIALIZE_OK ' + JSON.stringify(info))
} catch (error) {
  failed = true
  console.error('KERNEL_INITIALIZE_FAIL ' + (error instanceof Error ? error.message : String(error)))
} finally {
  await client.close()
}
process.exit(failed ? 1 : 0)
