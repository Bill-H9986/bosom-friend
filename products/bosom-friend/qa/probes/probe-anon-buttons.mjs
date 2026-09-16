// probe-anon-buttons.mjs - 首屏无名按钮排查
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
const info = await page.evaluate(() => {
  const unnamed = [...document.querySelectorAll('button')].filter(b => !(b.innerText || '').trim() && !(b.getAttribute('aria-label') || '').trim() && b.offsetParent !== null)
    .map(b => ({ cls: b.className.slice(0, 60), tag: b.tagName, par: b.closest('[role=dialog]') ? 'in-dialog' : 'page' }))
  const dialogs = [...document.querySelectorAll('[role=dialog]')].length
  return { unnamed, dialogs, bodyLen: document.body.innerText.length }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
console.log('DONE')
