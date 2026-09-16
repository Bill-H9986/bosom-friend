import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const w of [1440, 960]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: 800 } })).newPage()
  await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
  await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
  await page.waitForTimeout(9000)
  await page.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || '')); if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click() }; document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' }) })
  const m = await page.evaluate(() => { const c = document.querySelector('canvas'); return c ? { w: c.width, h: c.height } : null })
  console.log('W' + w + ': canvas=' + JSON.stringify(m))
  await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/probes/hero-' + w + '.png' })
  await page.close()
}
await browser.close()
console.log('DONE')
