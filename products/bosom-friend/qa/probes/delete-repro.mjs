#!/usr/bin/env node
/** 内容创作删除问题复现探针：只读结构探查 / 单条删除复现。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron, expect } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const mode = process.argv[2] ?? 'inspect'
const exe = process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe'
const app = await electron.launch({ executablePath: exe })
try {
  const page = await app.firstWindow()
  const apiLogs = []
  page.on('response', async (res) => {
    const url = res.url()
    if (/\/bosom-friend\/api\/.*(draft-generation|material|draft|plan)/.test(url)) {
      let body = ''
      try { body = (await res.text()).slice(0, 400) } catch {}
      const reqBody = res.request().postData() || ''
      apiLogs.push(`${res.request().method()} ${url} req=${reqBody.slice(0, 160)} -> ${res.status()} ${body}`)
    }
  })
  await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 120000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  const bodyText = await page.textContent('body').catch(() => '')
  console.log('PAGE_TEXT=' + (bodyText || '').replace(/\s+/g, ' ').slice(0, 1200))
  const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('[role="tab"], button'))
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => /生成记录|草稿|记录|我的/.test(t))
    .slice(0, 20))
  console.log('TABS=' + JSON.stringify(tabs))
  const deleteButtons = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el, i) => ({ i, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24), aria: el.getAttribute('aria-label') || '', testid: el.getAttribute('data-testid') || '' }))
    .filter((b) => /删除|清除/.test(b.text + b.aria + b.testid))
    .slice(0, 20))
  console.log('DELETE_BUTTONS=' + JSON.stringify(deleteButtons))
  if (mode === 'dump-buttons') {
    const allButtons = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
      .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
      .map((el) => ({ text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22), aria: el.getAttribute('aria-label') || '', testid: el.getAttribute('data-testid') || '' }))
      .filter((b) => b.text || b.aria || b.testid)
      .slice(0, 80))
    console.log('ALL_BUTTONS=' + JSON.stringify(allButtons))
  }
  if (mode === 'delete' && deleteButtons.length > 0) {
    const first = page.locator('button').filter({ hasText: /删除|清除/ }).first()
    await first.click()
    await page.waitForTimeout(800)
    const confirm = page.locator('button').filter({ hasText: /确认|确定/ }).first()
    if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirm.click()
      await page.waitForTimeout(1500)
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 60000 })
    await page.getByText('内容创作', { exact: true }).first().click()
    await page.waitForTimeout(2500)
    const afterText = await page.textContent('body').catch(() => '')
    console.log('AFTER_TEXT=' + (afterText || '').replace(/\s+/g, ' ').slice(0, 600))
  }
  if (mode === 'delete') {
    const genTab = page.locator('[role="tab"]').filter({ hasText: '生成记录' }).first()
    if (await genTab.isVisible({ timeout: 4000 }).catch(() => false)) {
      await genTab.click()
      await page.waitForTimeout(1800)
    } else {
      const fallbackTab = page.getByText('生成记录', { exact: true }).last()
      if (await fallbackTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await fallbackTab.click()
        await page.waitForTimeout(1800)
      }
    }
    const testids = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]'))
      .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
      .map((el) => el.getAttribute('data-testid'))
      .filter((v) => v && /gen|draft|record/i.test(v))
      .slice(0, 30))
    console.log('GEN_TESTIDS=' + JSON.stringify(testids))
    const firstRecord = page.locator('[data-testid*="gen"], [data-testid*="record"]').filter({ has: page.locator('[aria-label="删除生成记录"], button') }).first()
    if (await firstRecord.count() === 0) {
      const any = page.locator('div[class*="card"], article, li').filter({ has: page.locator('button[aria-label="删除生成记录"]') }).first()
      if (await any.count() > 0) await any.click().catch(() => {})
    } else {
      await firstRecord.click().catch(() => {})
    }
    await page.waitForTimeout(1200)
    const dialogButtons = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] button, .modal button, [class*="dialog"] button'))
      .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
      .map((el) => ({ text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20), aria: el.getAttribute('aria-label') || '', testid: el.getAttribute('data-testid') || '' }))
      .slice(0, 30))
    console.log('DIALOG_BUTTONS=' + JSON.stringify(dialogButtons))
    const del = page.locator('button[aria-label="删除生成记录"]').first()
    if (await del.count() === 0) {
      const fallback = page.locator('button').filter({ hasText: /删除|移除/ }).first()
      if (await fallback.count() > 0) await fallback.click().catch(() => {})
    } else {
      await del.click()
    }
    await page.waitForTimeout(600)
    const confirm = page.locator('button').filter({ hasText: /删除|确定/ }).last()
    if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirm.click()
      await page.waitForTimeout(1800)
    }
  }
  if (mode === 'draft-single') {
    const anyCard = page.locator('div[class*="card"], article').filter({ hasText: /请帮我|人社局|创作/ }).first()
    if (await anyCard.count() > 0) {
      await anyCard.click({ force: true }).catch(() => {})
      await page.waitForTimeout(1500)
      const delBtn = page.locator('[data-testid="draftbox-detail-delete-btn"]').first()
      if (await delBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        await delBtn.click()
        await page.waitForTimeout(700)
        const confirm = page.locator('button').filter({ hasText: /删除|确定/ }).last()
        if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirm.click()
          await page.waitForTimeout(2200)
        }
      } else {
        console.log('DETAIL_DELETE_BTN_NOT_FOUND')
      }
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 60000 })
    await page.getByText('内容创作', { exact: true }).first().click()
    await page.waitForTimeout(2500)
    const afterText = await page.textContent('body').catch(() => '')
    console.log('AFTER_TEXT=' + (afterText || '').replace(/\s+/g, ' ').slice(0, 400))
  }
  if (mode === 'draft-batch') {
    await page.locator('[role="tab"]').filter({ hasText: /^草稿/ }).first().click().catch(() => {})
    await page.waitForTimeout(1500)
    const batchBtn = page.locator('[data-testid="draftbox-batch-mode-btn"]').first()
    if (await batchBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('STEP batch-mode-btn-found')
      await batchBtn.click()
      await page.waitForTimeout(800)
    } else {
      console.log('STEP batch-mode-btn-not-found')
    }
    const boxes = page.locator('[data-testid="draftbox-draft-checkbox"]')
    const boxCount = await boxes.count()
    console.log('BOX_COUNT=' + boxCount)
    const firstBox = boxes.first()
    if (await firstBox.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstBox.click({ force: true }).catch(() => {})
      await page.waitForTimeout(500)
      const selected = await page.locator('[data-testid="draftbox-batch-selected-count"]').textContent().catch(() => '')
      console.log('STEP selected-count=' + JSON.stringify(selected))
      const delBtn = page.locator('[data-testid="draftbox-batch-delete-btn"]').first()
      if (await delBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('STEP batch-delete-btn-found')
        await delBtn.click()
        await page.waitForTimeout(700)
        const confirm = page.locator('button').filter({ hasText: /删除|确定/ }).last()
        if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirm.click()
          await page.waitForTimeout(2200)
        }
      } else {
        console.log('STEP batch-delete-btn-not-found')
      }
    } else {
      console.log('STEP no-checkbox-visible')
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 60000 })
    await page.getByText('内容创作', { exact: true }).first().click()
    await page.locator('[role="tab"]').filter({ hasText: /^草稿/ }).first().click().catch(() => {})
    await page.waitForTimeout(2500)
    const afterText = await page.textContent('body').catch(() => '')
    console.log('AFTER_TEXT=' + (afterText || '').replace(/\s+/g, ' ').slice(0, 500))
  }
  if (mode === 'batch-all') {
    const batchBtn = page.getByText('批量移除', { exact: false }).first()
    if (await batchBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await batchBtn.click()
      await page.waitForTimeout(800)
    }
    const firstCard = page.locator('div[class*="card"], article').first()
    if (await firstCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstCard.click({ force: true }).catch(() => {})
      await page.waitForTimeout(600)
    }
    const delBtn = page.locator('button').filter({ hasText: /^删除$|移除|删除/ }).last()
    if (await delBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await delBtn.click()
      await page.waitForTimeout(700)
      const confirm = page.locator('button').filter({ hasText: /删除|确定/ }).last()
      if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirm.click()
        await page.waitForTimeout(2400)
      }
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(/内容创作|数据中心|AI互动/).first()).toBeVisible({ timeout: 60000 })
    await page.getByText('内容创作', { exact: true }).first().click()
    await page.waitForTimeout(2500)
    const afterText = await page.textContent('body').catch(() => '')
    console.log('AFTER_TEXT=' + (afterText || '').replace(/\s+/g, ' ').slice(0, 300))
  }
  console.log('API_LOG=' + JSON.stringify(apiLogs))
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200))
  } catch {}
  await app.close().catch(() => {})
}
