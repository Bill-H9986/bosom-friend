#!/usr/bin/env node
/**
 * Bosom Friend 桌面运行时入口：dsh-base + 内核工具 + JSON-RPC + 官方 webServer + 产品业务服务。
 * 前端由产品业务服务托管在 http://127.0.0.1:31280/bosom-friend/，桌面壳加载该地址。
 * stdout 仅供 SDK JSON-RPC；Web 服务在独立端口，互不干扰。
 * @module @deepseek-ai/bosom-friend/bin-desktop
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { boot, installFailLoud, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

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
const CONFIG_PATH = fileURLToPath(new URL('../config/desktop.cordis.yml', import.meta.url))

const patches: PatchOptions[] = []
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
