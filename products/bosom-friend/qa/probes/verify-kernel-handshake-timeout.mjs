#!/usr/bin/env node
/**
 * 内核握手超时验收：子进程活着但不回应时，等待必须有界。
 *
 * 现实触发面：运行时被安全软件卡住、解压不完整、协议不匹配——进程在，但永远不回应。
 * 未加超时的那一版会停在"等待初始化握手"不动，用户既进不去也看不到原因（工作日志-2026-09-13）。
 * 这里用**桩入口**构造"进程活着但永远不回应"：真实入口现在 1 秒左右就握手成功，拿它测不到超时
 * （2026-09-16 实测：三条断言全红，因为根本没超时）。桩脚本起来后什么都不做、也不退出。
 * 超时预算故意设成 8 秒，避免验收本身等两分钟。
 *
 * 用法：node products/bosom-friend/qa/probes/verify-kernel-handshake-timeout.mjs
 * 退出码：0 = 通过；1 = 失败；2 = 环境不满足。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(dirname(HERE))
const repoRoot = dirname(dirname(PRODUCT))
const require = createRequire(import.meta.url)

const KERNEL_BIN = process.env.BF_KERNEL_BIN ?? join(PRODUCT, 'bundle', 'kernel', 'runtime', 'bin-desktop.mjs')
const BUDGET_MS = 8000
const checks = []
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''))
}

if (!existsSync(KERNEL_BIN)) {
  console.log('找不到内核入口：' + KERNEL_BIN)
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'bf-handshake-home-'))
const userData = mkdtempSync(join(tmpdir(), 'bf-handshake-userdata-'))
// 桩入口：进程活着、不输出、不退出、永不回应——正是这条验收要复现的形态。
const silentKernel = join(home, 'silent-kernel.mjs')
writeFileSync(silentKernel, 'setInterval(() => {}, 1000)\n', 'utf8')
process.env.BOSOM_FRIEND_HOME = home
process.env.BF_DESKTOP_PORT = process.env.BF_HANDSHAKE_PORT ?? '31297'
process.env.BF_KERNEL_BIN = silentKernel
// 直接指向桩入口，不依赖任何安装态运行时（真实入口会回应，测不到超时）。
delete process.env.BF_KERNEL_ROOT

const { createKernelHost } = require(join(PRODUCT, 'desktop', 'electron', 'kernel-host.cjs'))
const host = await createKernelHost({ handshakeTimeoutMs: BUDGET_MS })
const started = Date.now()
let message = ''
let threw = false
try {
  await host.start()
}
catch (error) {
  threw = true
  message = error instanceof Error ? error.message : String(error)
}
const elapsed = Date.now() - started

record('握手不回应时抛出错误而不是无限等待', threw, threw ? message : '未抛错（说明仍在无限等待）')
record('错误原因可读且点明超时', /握手超时/.test(message), message)
record('在预算内返回（' + BUDGET_MS + 'ms + 余量）', threw && elapsed <= BUDGET_MS + 6000, '实际 ' + elapsed + 'ms')

await host.close().catch(() => {})
rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

const failed = checks.filter(c => !c.ok)
console.log('KERNEL_HANDSHAKE ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
