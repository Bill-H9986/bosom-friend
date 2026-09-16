#!/usr/bin/env node
/** 清单第2条：真实创作链路（图文/视频 × 画幅 × 平台）。参数：mode=image|video ratio=3:4|9:16|16:9 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const { testid, openPanel, evidencePath } = await import('./creation-helpers.mjs')

const mode = process.argv[2] ?? 'image'
const ratio = process.argv[3] ?? '9:16'
const topic = '关于人社局无人机装调检修工程师就业免费培训'
const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await openPanel(app)
  // 1) 模式
  await testid(page, 'draftbox-ai-gen-mode').click()
  await page.waitForTimeout(600)
  await page.getByText(mode === 'video' ? '生成草稿(视频)' : '生成草稿(图文)', { exact: true }).last().click().catch(async () => {
    await page.getByText(mode === 'video' ? '生成草稿(视频)' : '生成草稿(图文)', { exact: true }).first().click()
  })
  await page.waitForTimeout(600)
  // 2) 平台：打开选择弹窗并勾选 小红书、抖音
  await page.getByText(/\d+ 个平台/).first().click()
  await page.waitForTimeout(700)
  const modalText = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"]')).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).join(' | '))
  console.log('PLATFORM_MODAL=' + modalText.slice(0, 400))
  for (const name of ['小红书', '抖音']) {
    const item = page.getByText(name, { exact: true }).last()
    if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
      await item.click({ force: true }).catch(() => {})
    }
  }
  await page.getByText(/确定|确认/, { exact: false }).last().click().catch(() => {})
  await page.waitForTimeout(700)
  const countText = await page.getByText(/\d+ 个平台/).first().textContent().catch(() => '')
  console.log('PLATFORM_COUNT=' + countText)
  // 3) 画幅
  await testid(page, 'draftbox-ai-ratio').click()
  await page.waitForTimeout(500)
  await page.getByText(ratio, { exact: true }).last().click().catch(async () => {
    await page.getByText(ratio, { exact: true }).first().click()
  })
  await page.waitForTimeout(500)
  // 4) 数量 x1
  await testid(page, 'draftbox-ai-quantity').click().catch(() => {})
  await page.waitForTimeout(400)
  await page.getByText('x1', { exact: true }).last().click().catch(() => {})
  // 5) 提示词
  await page.getByText('提示词', { exact: false }).first().click().catch(() => {})
  const prompt = page.locator('[data-testid="draftbox-ai-prompt-input"], textarea, input').filter({ has: page.locator('*') }).first()
  if (await prompt.isVisible({ timeout: 3000 }).catch(() => false)) {
    await prompt.fill(topic)
  }
  await page.waitForTimeout(400)
  await page.screenshot({ path: evidencePath('creation-before-submit-' + mode + '-' + ratio + '.png') }).catch(() => {})
  // 6) 提交
  await testid(page, 'draftbox-ai-submit-btn').click()
  console.log('SUBMITTED mode=' + mode + ' ratio=' + ratio)
  await page.waitForTimeout(4000)
  await page.screenshot({ path: evidencePath('creation-after-submit-' + mode + '-' + ratio + '.png') }).catch(() => {})
  const body = await page.textContent('body').catch(() => '')
  console.log('AFTER=' + (body || '').replace(/\s+/g, ' ').slice(0, 500))
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
