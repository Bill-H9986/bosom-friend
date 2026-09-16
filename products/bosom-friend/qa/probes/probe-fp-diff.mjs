// probe-fp-diff.mjs - 对比基线指纹差异（只读，不修改基线）
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const BASE = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend'
const baseline = JSON.parse(readFileSync(BASE + '/visual-baseline.json', 'utf8'))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
const routes = ['#/calendar', '#/monitor']
for (const rr of routes) {
  await page.evaluate(r2 => { location.hash = r2 }, rr)
  await page.waitForTimeout(3000)
  const sig = await page.evaluate(() => {
    const parts = []
    const els = document.querySelectorAll('aside, main, [data-testid=sidebar-nav], h1, .page-enter')
    for (const el of [].slice.call(els).slice(0, 8)) { const r = el.getBoundingClientRect(); parts.push([el.tagName, (el.className || '').toString().slice(0, 40), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]) }
    return JSON.stringify(parts).slice(0, 400)
  })
  console.log('ROUTE', rr)
  console.log(' BASE:', baseline[rr])
  console.log(' LIVE:', sig)
}
await browser.close()
