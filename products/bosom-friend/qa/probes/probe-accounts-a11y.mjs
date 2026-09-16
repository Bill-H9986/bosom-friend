// probe-accounts-a11y.mjs - 定位 accounts 页对比度违例
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/#/accounts', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
await page.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || '')); if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click() }; document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' }) })
await page.waitForTimeout(3000)
await page.addScriptTag({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/axe-core.min.js' })
const r = await page.evaluate(async () => {
  const res = await window.axe.run(document, { runOnly: ['color-contrast'] })
  return res.violations.map(v => ({ id: v.id, nodes: v.nodes.slice(0, 6).map(n => ({ target: n.target.slice(0, 3), html: (n.html || '').slice(0, 140), summary: n.failureSummary?.slice(0, 200) })) }))
})
console.log(JSON.stringify(r, null, 1).slice(0, 2600))
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/probes/accounts-a11y.png' })
await browser.close()
