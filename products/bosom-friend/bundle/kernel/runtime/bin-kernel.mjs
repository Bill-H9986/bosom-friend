#!/usr/bin/env node
/**
 * Bosom Friend 0.2.0 内核封闭运行时入口：在 pnpm deploy 物化的 node_modules 中启动
 * dsh-base + dsh-bosom-friend-kernel（含 dsh-sdk-jsonrpc-server）。stdout 只承载 JSON-RPC。
 *
 * 与 launcher/src/bin-kernel.ts 同源：按官方 SDK 客户端契约接收
 * `--profile <name> [--patch <file>]…`，补丁文件按 argv 顺序叠加在两层 bundle 之上。
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { boot, installFailLoud, loadOptionalPatches, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const NAME = 'bosom-friend-kernel'
const require = createRequire(import.meta.url)

process.env.DSH_HOME = process.env.BOSOM_FRIEND_HOME && process.env.BOSOM_FRIEND_HOME.trim() !== ''
  ? process.env.BOSOM_FRIEND_HOME.trim()
  : join(homedir(), '.bosom-friend')

const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-bosom-friend-kernel']
const CONFIG_PATH = fileURLToPath(new URL('../cordis.yml', import.meta.url))

function parseLaunchArgs(argv) {
  const patchFiles = []
  let profile
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--profile') {
      profile = argv[index + 1]
      index += 1
      continue
    }
    if (value === '--patch') {
      const file = argv[index + 1]
      if (file !== undefined) patchFiles.push(file)
      index += 1
    }
  }
  return { profile, patchFiles }
}

const launch = parseLaunchArgs(process.argv.slice(2))

const patches = []
for (const pkg of BUNDLES) {
  const file = require.resolve(pkg + '/cordis.patch.yml')
  const layer = loadOptionalPatches(NAME, file)
  if (layer !== undefined) patches.push(...layer)
}
for (const file of launch.patchFiles) patches.push(...loadOverlayPatches(NAME, file))

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
