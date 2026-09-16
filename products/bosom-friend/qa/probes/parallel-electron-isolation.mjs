#!/usr/bin/env node
/** 验证两个开发态 Electron 桌面实例可用独立端口 + 独立用户目录并行启动。 */
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const electronExe = join(repoRoot, 'products', 'bosom-friend', 'project', 'bosom-friend-electron', 'node_modules', 'electron', 'dist', 'electron.exe')
const desktopDir = join(repoRoot, 'products', 'bosom-friend', 'desktop')
const baseDir = mkdtempSync(join(tmpdir(), 'bf-electron-parallel-'))
const apps = []

async function launch(index, port) {
  const userData = join(baseDir, `user-data-${index}`)
  const home = join(baseDir, `home-${index}`)
  mkdirSync(userData, { recursive: true })
  mkdirSync(home, { recursive: true })
  const app = await electron.launch({
    executablePath: electronExe,
    args: [desktopDir, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      BF_DESKTOP_PORT: String(port),
      BOSOM_FRIEND_HOME: home,
      BF_FRONTEND_DIST: join(repoRoot, 'products', 'bosom-friend', 'project', 'bosom-friend-electron', 'dist'),
    },
  })
  const record = { app, port, userData, home }
  apps.push(record)
  return record
}

let pass = true
const results = []
try {
  const first = await launch(1, 31303)
  const second = await launch(2, 31304)
  for (const item of [first, second]) {
    const page = await item.app.firstWindow()
    await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
    const url = page.url()
    const version = await page.evaluate(() => window.__APP_VERSION__ ?? '').catch(() => '')
    console.log(`ELECTRON_PARALLEL port=${item.port} url=${url} version=${version}`)
    results.push({ port: item.port, url, version })
    if (!url.includes(`127.0.0.1:${item.port}/bosom-friend/`)) pass = false
  }
} catch (error) {
  console.error('ELECTRON_PARALLEL_FAIL=' + String(error))
  pass = false
} finally {
  for (const item of apps) {
    try {
      const win = item.app.windows()[0]
      if (win) await win.evaluate(() => window.bosomFriend?.quit?.()).catch(() => {})
      await new Promise((resolveWait) => setTimeout(resolveWait, 800))
      await item.app.close().catch(() => {})
    } catch {
      // best effort shutdown
    }
  }
}
console.log(`ELECTRON_PARALLEL_ISOLATION ${pass ? 'PASS' : 'FAIL'} evidence=${baseDir}`)
process.exit(pass ? 0 : 1)
