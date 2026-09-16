#!/usr/bin/env node
/** 探查提示词编辑器控件：点击“提示词”后列出输入框与按钮。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 120000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click().catch(() => {})
  await page.waitForTimeout(1000)
  const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('textarea, input'))
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el, i) => ({ i, tag: el.tagName, id: el.id || '', testid: el.getAttribute('data-testid') || '', placeholder: el.getAttribute('placeholder') || '', value: (el.value || '').slice(0, 50) })))
  console.log('INPUTS=' + JSON.stringify(inputs))
  const btns = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18)).filter(Boolean).slice(-15))
  console.log('BUTTONS=' + JSON.stringify(btns))
  const testids = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]'))
    .map((el) => el.getAttribute('data-testid'))
    .filter((v) => v && /prompt|editor|draft/.test(v))
    .slice(0, 30))
  console.log('EDITOR_TESTIDS=' + JSON.stringify(testids))
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
