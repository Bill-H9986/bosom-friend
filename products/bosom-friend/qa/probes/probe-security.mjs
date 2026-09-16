// probe-security.mjs - 设置页数据安全卡展示
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
await page.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || '')); if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click() }; document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' }) })
await page.evaluate(() => { location.hash = '#/settings' })
await page.waitForTimeout(3000)
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /系统与更新/.test(x.innerText || '')); if (b) b.click() })
await page.waitForTimeout(2500)
const r = await page.evaluate(() => {
  const t = document.body.innerText
  return {
    card: t.includes('数据安全（系统自动保障，无需任何操作）'),
    loopback: t.includes('仅本机'),
    acl: t.includes('仅当前用户可读写'),
    backup: /最近备份/.test(t),
    zeroOut: t.includes('零外发'),
  }
})
console.log('STATE: ' + JSON.stringify(r))
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/probes/security-tab.png' })
await browser.close()
console.log('DONE')
