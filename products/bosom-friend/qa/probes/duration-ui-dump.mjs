#!/usr/bin/env node
/** Dump the real duration popover state after selecting video mode. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(
  repoRoot,
  'node_modules',
  '.pnpm',
  'playwright@1.61.1',
  'node_modules',
  'playwright',
  'test',
))

const app = await electron.launch({
  executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe',
})
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)

  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(1000)

  console.log('MODEL=' + (await page.locator('[data-testid="draftbox-ai-model"]').first().textContent().catch(() => '')))
  const durationBtn = page.locator('[data-testid="draftbox-ai-duration"]').first()
  console.log('DUR_BTN=' + (await durationBtn.textContent().catch(() => '')))
  await durationBtn.click()
  await page.waitForTimeout(1200)

  const dump = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    return {
      buttons: Array.from(document.querySelectorAll('button'))
        .filter(visible)
        .map((el) => ({
          text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          disabled: el.disabled === true,
          testid: el.getAttribute('data-testid'),
        }))
        .filter((b) => /秒|分钟|时长/.test(b.text)),
      popovers: Array.from(document.querySelectorAll('[role="dialog"], [data-state="open"]'))
        .filter(visible)
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)),
      bodyTail: (document.body.innerText || '').replace(/\s+/g, ' ').slice(-600),
    }
  })
  console.log('DUMP=' + JSON.stringify(dump, null, 2))
  await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/evidence/checklist-2026-09-04/duration-ui-dump.png' }).catch(() => {})
} finally {
  try {
    const w = app.windows()[0]
    if (w) await w.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  try { await app.close().catch(() => {}) } catch {}
}
