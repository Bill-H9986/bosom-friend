#!/usr/bin/env node
/**
 * Bosom Friend 0.2.0 桌面运行时（随包版）：配置路径指向包内 cordis.yml。
 * 组合：dsh-base + 内核工具 + 桌面 bundle（webServer + 产品业务服务）。
 * stdout 仅供 SDK JSON-RPC；产品页由 webServer 在 127.0.0.1:31280 托管。
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { boot, installFailLoud, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'

const NAME = 'bosom-friend-desktop'
const require = createRequire(import.meta.url)

process.env.DSH_HOME = process.env.BOSOM_FRIEND_HOME && process.env.BOSOM_FRIEND_HOME.trim() !== ''
  ? process.env.BOSOM_FRIEND_HOME.trim()
  : join(homedir(), '.bosom-friend')

const BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-bosom-friend-kernel',
  '@deepseek-ai/dsh-bosom-friend-desktop-bundle',
]
const CONFIG_PATH = fileURLToPath(new URL('../cordis.yml', import.meta.url))

const patches = []
for (const pkg of BUNDLES) {
  const file = require.resolve(pkg + '/cordis.patch.yml')
  const layer = loadOptionalPatches(NAME, file)
  if (layer !== undefined) patches.push(...layer)
}

installFailLoud(NAME)
const ctx = await boot(NAME, CONFIG_PATH, patches)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void ctx.fiber.dispose().then(() => process.exit(signal === 'SIGINT' ? 130 : 0))
  })
}
process.stdin.on('end', () => {
  void ctx.fiber.dispose().then(() => process.exit(0))
})
