#!/usr/bin/env node
/** 视频终态观察：提交后不关 App；只读生成记录区最新卡片；终态=成功/失败且非生成中。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const topic = '关于人社局无人机装调检修工程师就业免费培训'
const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(800)
  const di = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  await di.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Delete')
  await page.keyboard.type(topic)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(700)
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
  await page.locator('[data-testid="draftbox-ai-submit-btn"]').first().click()
  console.log('VIDEO_SUBMIT')
  await page.waitForTimeout(6000)
  await page.getByText('生成记录', { exact: true }).last().click().catch(() => {})
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(15000)
    const cards = page.locator('[class*="generation-card"], [data-testid*="generation"], [class*="Generation"]').first()
    const tx = String(await cards.textContent().catch(() => '') || '').replace(/\s+/g, ' ')
    console.log('WATCH' + (i + 1) + '=' + tx.slice(0, 160))
    if (/刚刚/.test(tx) && /成功|失败|已生成|被中断/.test(tx)) break
  }
} finally {
  try { const w = app.windows()[0]; if (w) await w.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {}); await new Promise(r => setTimeout(r, 1500)) } catch {}
  try { await app.close().catch(() => {}) } catch {}
}
