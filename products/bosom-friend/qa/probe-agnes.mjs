#!/usr/bin/env node
/**
 * 诊断探针：进程内组合 dsh-base + 内核 bundle 补丁，列出 llm 服务实际注册的 provider。
 * 设置 PROBE_NO_KERNEL=1 可临时排除内核插件行，用于二分定位路由注册问题。
 * 运行：node --import tsx/esm products/bosom-friend/qa/probe-agnes.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { boot, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'

const tempHome = mkdtempSync(join(tmpdir(), 'bf-agnes-probe-'))
process.env.DSH_HOME = tempHome
process.env.DSH_PERMISSION_MODE = 'danger-full-access'

const require = createRequire(new URL('../launcher/src/bin-kernel.ts', import.meta.url).href)
const patches = []
for (const pkg of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-bosom-friend-kernel']) {
  const layer = loadOptionalPatches('probe-agnes', require.resolve(pkg + '/cordis.patch.yml')) ?? []
  for (const entry of layer) {
    if (Array.isArray(entry.insert)) {
      entry.insert = entry.insert.filter((row) => (
        row.name !== '@deepseek-ai/dsh-sdk-jsonrpc-server'
        && !(process.env.PROBE_NO_KERNEL === '1' && row.id === 'bosom-kernel')
      ))
    }
  }
  patches.push(...layer)
}

const config = fileURLToPath(new URL('../launcher/config/kernel.cordis.yml', import.meta.url))
const ctx = await boot('probe-agnes', config, patches)
const providers = ctx.get('llm')?.listProviders().map((entry) => entry.id) ?? []
console.log('AGNES_PROBE providers=' + providers.join(','))
await ctx.fiber.dispose()
rmSync(tempHome, { recursive: true, force: true })
process.exit(providers.includes('agnes') ? 0 : 1)
