#!/usr/bin/env node
/**
 * Bosom Friend 内核运行时入口（无 UI）：dsh-base → dsh-bosom-friend-kernel 两层 bundle
 * 补丁叠加；kernel bundle 同时挂载 dsh-sdk-jsonrpc-server。stdout 只承载 JSON-RPC 帧，
 * 所有诊断走 stderr。与 bin.ts（旧 Web 入口）并行存在（绞杀式迁移），本入口不加载任何 Web UI。
 *
 * 本入口按官方 SDK 客户端契约启动：`@deepseek-ai/dsh-sdk-client` 只按
 * `--profile <name> [--patch <file>]…` 拼 argv，因此这里必须能接收它们，而不是自造命令行。
 * @module @deepseek-ai/bosom-friend/bin-kernel
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { boot, installFailLoud, loadOptionalPatches, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const NAME = 'bosom-friend-kernel'
const require = createRequire(import.meta.url)

/** 产品数据根：与旧入口同一根，保证新旧路径读写同一份业务数据。 */
process.env.DSH_HOME = process.env.BOSOM_FRIEND_HOME && process.env.BOSOM_FRIEND_HOME.trim() !== ''
  ? process.env.BOSOM_FRIEND_HOME.trim()
  : join(homedir(), '.bosom-friend')

/** 内核组合：官方基础 + 自研内核工具（不包含 Web UI 与客户端系列包）。 */
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-bosom-friend-kernel']
const CONFIG_PATH = fileURLToPath(new URL('../config/kernel.cordis.yml', import.meta.url))

/**
 * 解析 SDK 客户端传来的 profile 选择参数。
 * @param argv - `process.argv` 的尾部参数。
 * @returns profile 名（可选）与 `--patch` 覆盖文件（按 argv 顺序）。
 */
function parseLaunchArgs(argv: string[]): { profile?: string; patchFiles: string[] } {
  const patchFiles: string[] = []
  let profile: string | undefined
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
  return { ...profile === undefined ? {} : { profile }, patchFiles }
}

const launch = parseLaunchArgs(process.argv.slice(2))

const patches: PatchOptions[] = []
for (const pkg of BUNDLES) {
  const file = require.resolve(pkg + '/cordis.patch.yml')
  const layer = loadOptionalPatches(NAME, file)
  if (layer !== undefined) patches.push(...layer)
}
for (const file of launch.patchFiles) patches.push(...loadOverlayPatches(NAME, file))

installFailLoud(NAME)
const ctx = await boot(NAME, CONFIG_PATH, patches)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void ctx.fiber.dispose().then(() => process.exit(signal === 'SIGINT' ? 130 : 0))
  })
}
// 客户端断开（stdin EOF）：按协议优雅退出，与 jsonrpc 插件的 shutdown 语义互补。
process.stdin.on('end', () => {
  void ctx.fiber.dispose().then(() => process.exit(0))
})
