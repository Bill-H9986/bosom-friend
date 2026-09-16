#!/usr/bin/env node
/** B1：侧栏 7 项导航逐项点击并验证页面有内容；每步截图。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const ev = (n) => join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04', n)

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  const items = ['内容创作', 'AI互动', '我的任务', '发布日历', '数据中心', '全局监控', '知识库']
  for (const label of items) {
    const el = page.locator('[data-testid^="sidebar-nav-item"]').filter({ hasText: label }).first()
    if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
      await el.click()
      await page.waitForTimeout(2000)
      const text = (await page.textContent('body').catch(() => ''))?.length ?? 0
      console.log('NAV ' + label + ' => contentLen=' + text)
      await page.screenshot({ path: ev('B1-' + label + '.png') }).catch(() => {})
    } else {
      console.log('NAV ' + label + ' => NOT_FOUND')
    }
  }
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
