#!/usr/bin/env node
/** 图片全比例实测：3:4 / 1:1 / 4:3 / 16:9 各生成一张（1080p），保持运行看终态。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const ev = (n) => join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04', n)
const topic = '关于人社局无人机装调检修工程师就业免费培训'

const ratios = ['3:4', '1:1', '4:3', '16:9']
const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  // 图文模式 + 提示词
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first().fill(topic)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(700)
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(图文)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)

  for (const ratio of ratios) {
    // 选比例
    await page.locator('[data-testid="draftbox-ai-ratio"]').first().click()
    await page.waitForTimeout(500)
    await page.getByText(ratio, { exact: true }).last().click().catch(async () => { await page.getByText(ratio, { exact: true }).first().click() })
    await page.waitForTimeout(600)
    // 选 1080p
    await page.locator('[data-testid="draftbox-ai-resolution"]').first().click()
    await page.waitForTimeout(600)
    const t = page.getByText('1080p', { exact: true }).last()
    if (await t.isVisible({ timeout: 2000 }).catch(() => false)) await t.click()
    await page.waitForTimeout(400)
    // 提交
    await page.locator('[data-testid="draftbox-ai-submit-btn"]').first().click()
    console.log('SUBMIT ' + ratio)
    await page.waitForTimeout(5000)
    // 盯最新记录终态（生成记录 tab 最新第一条的文本）
    await page.getByText('生成记录', { exact: true }).last().click().catch(() => {})
    let done = ''
    for (let i = 0; i < 24; i += 1) {
      await page.waitForTimeout(10000)
      const text = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ').slice(-400) ?? ''
      await page.screenshot({ path: ev('IMG-' + ratio + '-poll' + (i + 1) + '.png') }).catch(() => {})
      if (/生成成功|已生成|刚刚成功|刚刚已生成/.test(text)) { done = text; break }
      if (/刚刚生成失败|生成失败/.test(text) && !/生成中|进行中/.test(text)) { done = text; break }
    }
    console.log('TERMINAL ' + ratio + '=' + JSON.stringify((done || '').slice(0, 120)))
    // 回到创作面板准备下一个（点击“创作”区块）
    await page.getByText('内容创作', { exact: true }).first().click().catch(() => {})
    await page.waitForTimeout(1500)
  }
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
