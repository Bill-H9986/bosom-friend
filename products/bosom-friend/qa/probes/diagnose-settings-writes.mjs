#!/usr/bin/env node
/**
 * 诊断：打开「设置 → 自定义大模型」期间，前端有没有对 ai/user-llm 发写请求。
 * 模型配置被清空过一次（providers 变成 []），必须查清是产品行为还是测试行为。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { chromium } = require(join(repoRoot, 'products/bosom-friend/qa/e2e/node_modules/playwright'))
const BASE = process.env.BF_QA_BASE ?? 'http://127.0.0.1:31280/bosom-friend/'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })).newPage()
const writes = []
page.on('request', (req) => {
  const url = req.url()
  if (!url.includes('/api/ai/user-llm') && !url.includes('/api/ai/models')) return
  writes.push(req.method() + ' ' + url.split('/api/')[1] + ' body=' + (req.postData() ?? '').slice(0, 160))
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  for (let i = 0; i < 5; i += 1) {
    const btn = page.locator("button:has-text('同意并进入平台')").first()
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) await btn.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(300)
  }
  await page.getByTestId('sidebar-user-trigger').first().click()
  await page.waitForTimeout(800)
  await page.getByTestId('sidebar-settings-entry').first().click()
  await page.waitForTimeout(1500)
  await page.getByText('自定义大模型', { exact: true }).first().click()
  await page.waitForTimeout(6000)
  const rows = await page.locator('[data-testid="llm-provider-item"]').count()
  console.log('SETTINGS_ROWS=' + rows)
  console.log('WRITES=' + JSON.stringify(writes, null, 1))
}
finally {
  await browser.close()
}
