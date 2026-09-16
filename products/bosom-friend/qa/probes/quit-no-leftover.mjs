#!/usr/bin/env node
/** 完全退出零残留验证：退出后不得有隐藏实例占单实例锁；立即重开必须成功。 */
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron, expect } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const exe = process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe'
const portOpen = () => new Promise((resolve) => {
  const sock = net.connect(31280, '127.0.0.1')
  sock.once('connect', () => { sock.destroy(); resolve(true) })
  sock.once('error', () => resolve(false))
  sock.setTimeout(2000, () => { sock.destroy(); resolve(false) })
})
const bosomProcessCount = () => {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Bosom Friend.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return out.trim() === '' ? 0 : out.trim().split(/\r?\n/).length
  } catch {
    return 0
  }
}
const bosomSnapshot = () => {
  const script = 'Get-CimInstance Win32_Process -Filter "Name=\'Bosom Friend.exe\'" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  } catch {
    return 'SNAPSHOT_ERROR'
  }
}

const app = await electron.launch({ executablePath: exe })
try {
  const page = await app.firstWindow()
  await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 300000 })
  console.log('STEP app-ready')
  // 关闭窗口 → 隐藏到托盘（设计行为）
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  await new Promise((resolveWait) => setTimeout(resolveWait, 2000))
  console.log('STEP after-close processCount=' + bosomProcessCount() + ' port=' + await portOpen())
  // 完全退出（托盘菜单同路径）
  await page.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
  let countAfterQuit = -1
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    countAfterQuit = bosomProcessCount()
    if (countAfterQuit > 0) {
      try {
        console.log('STEP t+' + (i + 1) * 0.5 + 's survivor=' + bosomSnapshot().trim())
      } catch {}
    }
    if (countAfterQuit === 0)
      break
  }
  const portAfterQuit = await portOpen()
  console.log('STEP after-quit-final processCount=' + countAfterQuit + ' port=' + portAfterQuit)
  await app.close().catch(() => {})
  // 立即重开：若锁未释放，新实例会秒退
  const second = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
  second.unref()
  await new Promise((resolveWait) => setTimeout(resolveWait, 8000))
  const relaunchAlive = bosomProcessCount() > 0
  console.log('STEP relaunch alive=' + relaunchAlive)
  process.exitCode = countAfterQuit === 0 && !portAfterQuit && relaunchAlive ? 0 : 1
} finally {
  try { await app.close().catch(() => {}) } catch {}
}
