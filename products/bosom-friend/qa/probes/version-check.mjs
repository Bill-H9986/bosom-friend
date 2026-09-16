#!/usr/bin/env node
/** 桌面版本显示探针：校验 window.__APP_VERSION__ 注入与设置页展示。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron, expect } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const exe = process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe'
const app = await electron.launch({ executablePath: exe })
try {
  const page = await app.firstWindow()
  await expect(page.getByText(/内容创作|数据中心|AI互动|账号管理|发布日历/).first()).toBeVisible({ timeout: 120000 })
  const injected = await page.evaluate(() => window.__APP_VERSION__)
  console.log('INJECTED __APP_VERSION__=' + JSON.stringify(injected))
  let settingsOk = false
  try {
    await page.locator('[data-testid=sidebar-user-trigger]').first().click()
    await page.waitForTimeout(1000)
    const menuText = await page.textContent('body').catch(() => '')
    console.log('MENU_TEXT=' + (menuText || '').replace(/\s+/g, ' ').slice(-400))
    const settings = page.getByText('设置', { exact: true }).first()
    if (await settings.isVisible({ timeout: 5000 }).catch(() => false)) {
      await settings.click()
      await page.waitForTimeout(1200)
      const otaTab = page.getByText('系统与更新', { exact: true }).first()
      if (await otaTab.isVisible({ timeout: 5000 }).catch(() => false)) {
        await otaTab.click()
        await page.waitForTimeout(800)
      }
      settingsOk = await expect(page.getByText(new RegExp('v0\\.2\\.6')).first()).toBeVisible({ timeout: 10000 }).then(() => true).catch(() => false)
      if (!settingsOk) {
        const modalText = await page.textContent('body').catch(() => '')
        console.log('AFTER_SETTINGS_TEXT=' + (modalText || '').replace(/\s+/g, ' ').slice(-500))
      }
    }
  } catch {}
  console.log('SETTINGS_SHOWS_v0.2.2=' + settingsOk)
  process.exitCode = injected === '0.2.2' && settingsOk ? 0 : 1
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200))
  } catch {}
  await app.close().catch(() => {})
}
