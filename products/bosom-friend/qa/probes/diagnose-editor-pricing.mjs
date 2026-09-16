#!/usr/bin/env node
/** 诊断：提示词编辑器真实输入控件 + pricing 接口返回。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  let pricing = ''
  page.on('response', async (res) => {
    if (res.url().includes('/ai/draft-generation/pricing') && res.request().method() === 'GET') {
      pricing = await res.text().catch(() => '')
    }
  })
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(1000)
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"]'))
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el, i) => ({
      i,
      tag: el.tagName,
      editable: el.getAttribute('contenteditable'),
      testid: el.getAttribute('data-testid') || '',
      placeholder: el.getAttribute('placeholder') || '',
      cls: (el.className || '').toString().slice(0, 60),
      inDialog: !!el.closest('[role="dialog"]'),
    })))
  console.log('EDITOR_FIELDS=' + JSON.stringify(fields))
  const dialogs = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => (d.getAttribute('data-testid') || '') + '|' + (d.textContent || '').slice(0, 60)))
  console.log('DIALOGS=' + JSON.stringify(dialogs))
  await page.getByText('取消', { exact: true }).first().click().catch(() => {})
  await page.waitForTimeout(1200)
  const p = JSON.parse(pricing || '{}')
  const im = p?.data?.imageModels?.[0]
  console.log('PRICING_IMAGE0=' + JSON.stringify(im ? { model: im.model, pricing: im.pricing } : null).slice(0, 700))
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
