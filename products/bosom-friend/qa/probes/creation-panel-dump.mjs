#!/usr/bin/env node
/** 创作面板交互组件探查：模式/平台/画幅/数量/提交相关控件。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const { testid, openPanel } = await import('./creation-helpers.mjs')

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await openPanel(app)
  const all = await page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"], [role="radio"], [role="menuitem"]'))
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el, i) => ({ i, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22), aria: el.getAttribute('aria-label') || '', testid: el.getAttribute('data-testid') || '', role: el.getAttribute('role') || '' }))
    .filter((b) => b.text || b.aria || b.testid)
    .slice(0, 90))
  console.log('ALL=' + JSON.stringify(all))
  // 点模式
  await testid(page, 'draftbox-ai-gen-mode').click().catch(() => {})
  await page.waitForTimeout(700)
  const modes = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], li, button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)).filter((t) => /图文|视频|视频教程|文字/.test(t)).slice(0, 20))
  console.log('MODES=' + JSON.stringify(modes))
  // 点平台选择（"N 个平台"按钮）
  await page.getByText(/\d+ 个平台/).first().click().catch(() => {})
  await page.waitForTimeout(700)
  const platformModal = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [class*="modal"], [class*="popover"]')).map((el) => (el.textContent || '').replace(/\s+/g, ' ').slice(0, 300)).slice(0, 5))
  console.log('PLATFORM_MODAL=' + JSON.stringify(platformModal))
  // 点画幅
  await testid(page, 'draftbox-ai-ratio').click().catch(() => {})
  await page.waitForTimeout(700)
  const ratios = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)).filter((t) => /^9:16|^16:9|^1:1|^3:4|^4:3/.test(t)).slice(0, 20))
  console.log('RATIOS=' + JSON.stringify(ratios))
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
