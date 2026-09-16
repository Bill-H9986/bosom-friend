#!/usr/bin/env node
/** 列出视频/图文面板的可选分辨率、时长、画幅、图片尺寸。 */
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
  const dump = async (selector, label) => {
    await page.locator('[data-testid="' + selector + '"]').first().click().catch(() => {})
    await page.waitForTimeout(500)
    const opts = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button'))
      .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30))
      .filter((t) => /px|p$|p |K|秒|分钟|:/.test(t) || /^[0-9]+$/.test(t))
      .slice(0, 20))
    console.log(label + '=' + JSON.stringify(opts))
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(300)
  }
  await dump('draftbox-ai-video-resolution', 'VIDEO_RES')
  await dump('draftbox-ai-duration', 'VIDEO_DUR')
  await dump('draftbox-ai-ratio', 'RATIO')
  // 切图文
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(图文)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(800)
  const imageControls = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]'))
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el) => el.getAttribute('data-testid'))
    .filter((v) => v && /image|resolution|size|ratio|model/.test(v))
    .slice(0, 30))
  console.log('IMAGE_CONTROLS=' + JSON.stringify(imageControls))
  for (const ctrl of imageControls.filter((v) => /resolution|size/.test(v)).slice(0, 2)) {
    await dump(ctrl, 'IMG_' + ctrl)
  }
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
