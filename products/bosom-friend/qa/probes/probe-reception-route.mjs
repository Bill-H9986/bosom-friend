// 诊断：打印 #/accounts 页面可见文本与 tab 数量，不写产品数据。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:3086/bosom-friend/'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', error => console.log('PAGEERROR', String(error).slice(0, 300)))
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning')
    console.log(`CONSOLE ${message.type()}`, message.text().slice(0, 500))
})
page.on('response', response => {
  if (response.status() >= 400)
    console.log('HTTP', response.status(), response.url().slice(0, 300))
})
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(8000)
const dlg = page.locator('[role=dialog]').filter({ hasText: '免责声明' }).first()
if (await dlg.count() > 0) {
  await dlg.locator('button:has-text("我已阅读并同意")').first().click({ timeout: 3000 }).catch(() => {})
  await dlg.locator('button:has-text("同意并进入平台")').first().click({ timeout: 3000 }).catch(() => {})
}
await page.goto(`${BASE}?planId=mg-persist#/accounts`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(10000)
console.log('URL=' + page.url())
console.log('TABS=' + await page.locator('.ant-tabs-tab').count())
console.log((await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))).slice(0, 1200))
await browser.close()
