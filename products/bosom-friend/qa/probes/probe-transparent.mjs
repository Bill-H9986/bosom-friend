// probe-transparent.mjs - 验证按钮背景透明 + 截图
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
await page.waitForTimeout(300)
const info = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('[data-testid=sidebar-toggle-btn], [data-testid=ai-assistant-collapse-btn]')]
  return JSON.stringify(btns.map(b => ({ id: b.dataset.testid, bg: getComputedStyle(b).backgroundColor, shadow: getComputedStyle(b).boxShadow })))
})
console.log('BUTTONS:', info)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/final-expanded.png' })
await browser.close()
console.log('DONE')
