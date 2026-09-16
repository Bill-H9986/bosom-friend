#!/usr/bin/env node
/** 验证图片分辨率与视频分辨率档位对齐（均为 720p/1080p）。 */
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
  const list = async (testid, ratioSupported) => {
    await page.locator('[data-testid="' + testid + '"]').first().click()
    await page.waitForTimeout(600)
    const opts = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').trim()).filter((t) => /720p|1080p|960p|2K|480p/.test(t)).slice(0, 10))
    console.log(testid + '=>' + JSON.stringify(opts))
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(400)
  }
  // 图片档位
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(图文)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
  await list('draftbox-ai-resolution', true)
  // 视频档位
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
  await list('draftbox-ai-video-resolution', true)
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
