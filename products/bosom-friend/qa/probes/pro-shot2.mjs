// pro-shot2.mjs - 勾选不再提示并继续使用后重拍
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
const before = await page.evaluate(() => [...document.querySelectorAll('[role=dialog]')].map(d => (d.innerText || '').slice(0, 40)))
console.log('DIALOGS:', JSON.stringify(before))
await page.evaluate(() => {
  const dialog = [...document.querySelectorAll('[role=dialog]')].find(d => /温馨提示/.test(d.innerText || ''))
  if (!dialog) return
  const cb = dialog.querySelector('[role=checkbox], input[type=checkbox]')
  if (cb) cb.click()
})
await page.waitForTimeout(400)
await page.evaluate(() => {
  const dialog = [...document.querySelectorAll('[role=dialog]')].find(d => /温馨提示/.test(d.innerText || ''))
  if (!dialog) return
  const use = [...dialog.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || ''))
  if (use) use.click()
})
await page.waitForTimeout(1500)
const after = await page.evaluate(() => [...document.querySelectorAll('[role=dialog]')].length)
console.log('DIALOGS-AFTER:', after)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-expanded.png' })
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-collapse-btn]')?.click())
await page.waitForTimeout(800)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-collapsed.png' })
await browser.close()
console.log('DONE')
