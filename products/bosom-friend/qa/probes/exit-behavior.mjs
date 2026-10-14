#!/usr/bin/env node
/** 退出行为验证：关闭窗口=进程保留；完全退出=进程全停。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron, expect } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const portOpen = () => new Promise((resolve) => {
  const sock = net.connect(31280, '127.0.0.1')
  sock.once('connect', () => { sock.destroy(); resolve(true) })
  sock.once('error', () => resolve(false))
  sock.setTimeout(2000, () => { sock.destroy(); resolve(false) })
})

const processAlive = (pid) => {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return out.includes(String(pid))
  } catch {
    return false
  }
}

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 300000 })
  const pid = app.process().pid
  // 关闭窗口：应隐藏到托盘，进程与内核保持运行
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  await new Promise((resolveWait) => setTimeout(resolveWait, 2500))
  const aliveAfterClose = processAlive(pid)
  const portAfterClose = await portOpen()
  console.log('EXIT_BEHAVIOR close: processAlive=' + aliveAfterClose + ' portAlive=' + portAfterClose + ' pid=' + pid)
  // 再次拉起同一 exe：单实例锁应把隐藏窗口重新显示
  const { spawn } = await import('node:child_process')
  const second = spawn(process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe', [], { detached: true, stdio: 'ignore', windowsHide: false })
  second.unref()
  await new Promise((resolveWait) => setTimeout(resolveWait, 2500))
  const visibleWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible()).length)
  console.log('EXIT_BEHAVIOR reopen: visibleWindows=' + visibleWindows)
  // 完全退出：经产品 IPC 走 quitAndStop，进程与内核全部停止
  await app.evaluate(({ app: appMod }) => { appMod.quit() })
  await new Promise((resolveWait) => setTimeout(resolveWait, 2500))
  const exited = !processAlive(pid)
  const portAfterQuit = await portOpen()
  console.log('EXIT_BEHAVIOR fullQuit: exited=' + exited + ' portAlive=' + portAfterQuit)
  process.exitCode = aliveAfterClose && portAfterClose && exited && !portAfterQuit ? 0 : 1
} finally {
  try { await app.close().catch(() => {}) } catch {}
}
