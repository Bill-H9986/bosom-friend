#!/usr/bin/env node
/** 验证图片分辨率随比例联动（3:4 → 1080x1440/1440x1920 等）。 */
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
  // 切图文
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(图文)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
  const check = async (ratio) => {
    await page.locator('[data-testid="draftbox-ai-ratio"]').first().click()
    await page.waitForTimeout(500)
    await page.getByText(ratio, { exact: true }).last().click().catch(async () => {
      await page.getByText(ratio, { exact: true }).first().click()
    })
    await page.waitForTimeout(700)
    const currentRatio = await page.locator('[data-testid="draftbox-ai-ratio"]').first().textContent().catch(() => '')
    await page.locator('[data-testid="draftbox-ai-resolution"]').first().click()
    await page.waitForTimeout(600)
    const sizes = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').trim()).filter((t) => /^\d+x\d+$/.test(t)).slice(0, 10))
    console.log(ratio + ' => ratioLabel=' + currentRatio + ' sizes=' + JSON.stringify(sizes))
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(400)
  }
  await check('3:4')
  await check('9:16')
  await check('1:1')
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
