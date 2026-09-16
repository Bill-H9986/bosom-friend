// probe-err.mjs - 捕获页面错误与 canvas 生命周期
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 600)))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 400)) })
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
const snap = await page.evaluate(() => {
  const c = document.querySelector('[data-testid=logo-particle-field]')
  const hero = (document.body.innerText || '').includes('内容创作营销系统')
  return { canvas: !!c, hero, len: (document.body.innerText || '').length }
})
console.log('STATE:', JSON.stringify(snap))
await browser.close()
console.log('DONE')
