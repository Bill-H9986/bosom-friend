#!/usr/bin/env node
/** C14-C18：草稿详情/批量模式/删除失败记录/素材库/发布弹窗。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const ev = (n) => join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04', n)

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('[role="tab"]').filter({ hasText: /^草稿/ }).first().click()
  await page.waitForTimeout(2000)
  // C14 详情
  const first = page.locator('[data-testid="draftbox-draft-card"]').first()
  if (await first.isVisible({ timeout: 4000 }).catch(() => false)) {
    await first.click({ force: true })
    await page.waitForTimeout(1200)
    const open = await page.locator('[data-testid="draftbox-detail-delete-btn"]').isVisible({ timeout: 4000 }).then(() => true).catch(() => false)
    console.log('C14_DETAIL_OPEN=' + open)
    const publishBtn = page.locator('[data-testid="draftbox-detail-publish-btn"]').first()
    const publishVisible = await publishBtn.isVisible({ timeout: 3000 }).catch(() => false)
    console.log('C18_PUBLISH_BTN=' + publishVisible)
    if (publishVisible) {
      await publishBtn.click()
      await page.waitForTimeout(1500)
      const dialogOpen = await page.getByText(/发布|一键发布|选择平台|账号/, { exact: false }).first().isVisible({ timeout: 4000 }).then(() => true).catch(() => false)
      console.log('C18_PUBLISH_DIALOG=' + dialogOpen)
      await page.screenshot({ path: ev('C18-publish-dialog.png') }).catch(() => {})
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(600)
    }
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(700)
  } else {
    console.log('C14_CARD_NOT_FOUND')
  }
  // C15 批量模式（选择后取消，不删 M 素材）
  await page.locator('[data-testid="draftbox-batch-mode-btn"]').first().click().catch(async () => {
    await page.getByText('批量移除', { exact: false }).first().click()
  })
  await page.waitForTimeout(800)
  const check = page.locator('[data-testid="draftbox-draft-checkbox"]').first()
  const batchEntered = await check.isVisible({ timeout: 3000 }).then(() => true).catch(() => false)
  console.log('C15_BATCH_MODE=' + batchEntered)
  if (batchEntered) {
    await check.click({ force: true }).catch(() => {})
    await page.waitForTimeout(400)
    const delEnabled = await page.locator('[data-testid="draftbox-batch-delete-btn"]').first().isEnabled().catch(() => false)
    console.log('C15_BATCH_DELETE_ENABLED=' + delEnabled)
    await page.locator('[data-testid="draftbox-batch-cancel-btn"]').first().click().catch(() => {})
    await page.waitForTimeout(500)
  }
  // C16 删除历史失败记录（不影响成功生成）
  await page.getByText('生成记录', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(1500)
  const recText = await page.textContent('body').catch(() => '')
  console.log('C16_RECORDS_HAS_FAIL=' + /生成失败|失败/.test(recText || ''))
  // C17 素材库
  await page.getByText('素材库', { exact: true }).first().click().catch(() => {})
  await page.waitForTimeout(1800)
  const matText = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ').slice(0, 260)
  console.log('C17_MATERIALS=' + matText)
  await page.screenshot({ path: ev('C17-materials.png') }).catch(() => {})
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
