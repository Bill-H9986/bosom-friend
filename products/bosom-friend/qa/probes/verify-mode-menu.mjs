#!/usr/bin/env node
/** 验证创作模式菜单只有两个草稿模式。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(700)
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => /生成草稿|生成图片|生成视频/.test(t)).slice(0, 10))
  console.log('MODE_OPTIONS=' + JSON.stringify(options))
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
