#!/usr/bin/env node
/**
 * Bosom Friend 桌面运行时入口：dsh-base + 内核工具 + JSON-RPC + 官方 webServer + 产品业务服务。
 * 前端由产品业务服务托管在 http://127.0.0.1:31280/bosom-friend/，桌面壳加载该地址。
 * stdout 仅供 SDK JSON-RPC；Web 服务在独立端口，互不干扰。
 * @module @deepseek-ai/bosom-friend/bin-desktop
 */

import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
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

/**
 * 远程访问的「局域网可达」开关：监听地址是启动时定的，所以这里必须在**加载补丁之前**读配置。
 *
 * 时机是这个函数的全部要害：补丁里的 `!!js` 表达式在 `loadOptionalPatches` 解析 YAML 时就被求值了，
 * 设晚了那个表达式读到的还是旧环境（实测：日志说"监听 0.0.0.0"，socket 上仍然是 127.0.0.1）。
 *
 * 配置由产品服务端维护（`<DSH_HOME>/bosom-friend/remote-access.json`），启动器只读不改。
 * 读不到、读坏了一律按默认（只监听回环）——安全的默认值，绝不因为一个坏文件把机器暴露出去。
 */
function applyRemoteBindSetting(): void {
  try {
    const file = join(process.env.DSH_HOME ?? '', 'bosom-friend', 'remote-access.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown, bindAll?: unknown }
    if (raw.enabled === true && raw.bindAll === true) {
      process.env.BF_BIND_HOST = '0.0.0.0'
      console.log('[remote-access] 配置要求局域网可达，本次监听 0.0.0.0')
    }
  }
  catch {
    // 没配过或文件损坏：保持只监听回环。
  }
}

applyRemoteBindSetting()

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
