#!/usr/bin/env node
/** 清单第 2 条探针：创作面板结构 + 指定主题创建。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron, expect } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const mode = process.argv[2] ?? 'inspect'
const exe = process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe'
const app = await electron.launch({ executablePath: exe })
try {
  const page = await app.firstWindow()
  await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04', '02-creation-panel.png') }).catch(() => {})
  const ids = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]'))
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el) => el.getAttribute('data-testid'))
    .filter(Boolean)
    .slice(0, 60))
  console.log('PANEL_TESTIDS=' + JSON.stringify(ids))
  if (mode === 'create') {
    const prompt = page.locator('[data-testid="draftbox-ai-prompt-input"], textarea, input[placeholder*="提示词"], input[placeholder*="需求"]').first()
    if (await prompt.isVisible({ timeout: 5000 }).catch(() => false)) {
      await prompt.fill('关于人社局无人机装调检修工程师就业免费培训')
      console.log('STEP prompt-filled')
    } else {
      console.log('STEP prompt-not-found')
    }
    await page.screenshot({ path: join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04', '02-created-prompt.png') }).catch(() => {})
    const submit = page.locator('[data-testid="draftbox-ai-submit-btn"]').first()
    if (await submit.isVisible({ timeout: 4000 }).catch(() => false)) {
      await submit.click()
      console.log('STEP submit-clicked')
      await page.waitForTimeout(5000)
      await page.screenshot({ path: join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04', '02-after-submit.png') }).catch(() => {})
      const body = await page.textContent('body').catch(() => '')
      console.log('STEP after-submit-text=' + (body || '').replace(/\s+/g, ' ').slice(0, 500))
    } else {
      console.log('STEP submit-not-found')
    }
  }
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200))
  } catch {}
  await app.close().catch(() => {})
}
