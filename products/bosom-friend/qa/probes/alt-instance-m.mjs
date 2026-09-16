#!/usr/bin/env node
/** 探测独立用户数据目录是否允许并行启动第二个桌面实例。 */
import { createRequire } from 'node:module'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const userData = join(repoRoot, 'products/bosom-friend/qa/evidence/alt-user-data')
const app = await electron.launch({
  executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe',
  args: [`--user-data-dir=${userData}`],
})
try {
  const page = await app.firstWindow()
  await page.waitForTimeout(2000)
  const version = await page.evaluate(() => window.__APP_VERSION__ ?? '').catch(() => '')
  console.log('ALT_WINDOW=1 VERSION=' + version)
} catch (error) {
  console.log('ALT_FAIL=' + String(error))
} finally {
  try { const w = app.windows()[0]; if (w) await w.evaluate(() => window.bosomFriend?.quit?.()).catch(() => {}) } catch {}
  try { await app.close().catch(() => {}) } catch {}
}
