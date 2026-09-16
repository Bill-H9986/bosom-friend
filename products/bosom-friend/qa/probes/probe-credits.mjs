// probe-credits.mjs - 设置页额度卡截图
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
await page.evaluate(() => {
  const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || ''))
  if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click() }
  document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' })
})
await page.evaluate(() => { location.hash = '#/settings' })
await page.waitForTimeout(3000)
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].filter(x => /自定义大模型/.test(x.innerText || '')); if (b[0]) b[0].click() })
await page.waitForTimeout(2600)
const info = await page.evaluate(() => ({
  creditsCard: document.body.innerText.includes('AI 系统额度'),
  balanceShown: /余额 \d+ 点/.test(document.body.innerText),
  redeem: document.body.innerText.includes('兑换卡密'),
  buyHint: document.body.innerText.includes('向管理员购买'),
}))
console.log('STATE:', JSON.stringify(info))
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/probes/credits-tab.png' })
await browser.close()
console.log('DONE')
