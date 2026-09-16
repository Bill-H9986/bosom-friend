#!/usr/bin/env node
/**
 * 删除持久性回归（S 级：只操作真实页面）：
 * 创建一条草稿 → 单条删除 → 刷新页面 → 断言该草稿不再可见。
 * 防回归：P-004 后续发现的“删不掉”现象（ID 缺失时假成功已修复）。
 * 运行：node products/bosom-friend/qa/delete-persistence.mjs
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const { _electron: electron, expect } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const exe = process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe'
const title = '删除回归-' + Date.now()
const app = await electron.launch({ executablePath: exe })
let ok = false
try {
  const page = await app.firstWindow()
  const apiLogs = []
  page.on('response', async (res) => {
    if (/\/bosom-friend\/api\/material/.test(res.url())) {
      let body = ''
      try { body = (await res.text()).slice(0, 180) } catch {}
      apiLogs.push(`${res.request().method()} ${res.url()} -> ${res.status()} ${body}`)
    }
  })
  await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 120000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('[role="tab"]').filter({ hasText: /^草稿/ }).first().click().catch(() => {})
  await page.waitForTimeout(1500)
  // 删除现有第一条草稿（回归对象为“删除后必须持久消失”）
  const card = page.locator('[data-testid="draftbox-draft-card"]').first()
  const title = (await card.locator('p').first().textContent().catch(() => ''))?.replace(/\s+/g, ' ').slice(0, 60) ?? ''
  console.log('STEP target-title=' + title)
  const found = await card.isVisible({ timeout: 8000 }).then(() => true).catch(() => false)
  console.log('STEP card-found=' + found)
  if (!found) {
    console.log('DELETE_PERSISTENCE FAIL 创建或定位草稿失败')
    process.exitCode = 1
  } else {
    await card.click({ force: true }).catch(() => {})
    await page.waitForTimeout(1200)
    const dialogIds = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] [data-testid], [class*="dialog"] [data-testid]'))
      .map((el) => el.getAttribute('data-testid')).slice(0, 30))
    const delCount = await page.locator('[data-testid="draftbox-detail-delete-btn"]').count()
    console.log('STEP dialogIds=' + JSON.stringify(dialogIds) + ' delCount=' + delCount)
    const del = page.locator('[data-testid="draftbox-detail-delete-btn"]').first()
    if (await del.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('STEP detail-delete-btn-found')
      await del.click()
      await page.waitForTimeout(600)
      const confirm = page.locator('button').filter({ hasText: /删除|确定/ }).last()
      if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirm.click()
        await page.waitForTimeout(2000)
      }
    }
    else {
      console.log('STEP detail-delete-btn-not-found')
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 60000 })
    await page.getByText('内容创作', { exact: true }).first().click()
    await page.waitForTimeout(2500)
    const stillThere = await page.locator('[data-testid="draftbox-draft-card"]').filter({ hasText: title }).first().isVisible({ timeout: 5000 }).then(() => true).catch(() => false)
    ok = !stillThere
    console.log('DELETE_PERSISTENCE ' + (ok ? 'PASS' : 'FAIL') + ' 刷新后记录仍可见=' + stillThere)
    console.log('API_LOG=' + JSON.stringify(apiLogs))
  }
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200))
  } catch {}
  await app.close().catch(() => {})
}
process.exitCode = ok ? 0 : 1
