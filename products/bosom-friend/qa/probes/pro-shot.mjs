// pro-shot.mjs - 关闭 Agent 免责弹窗后重拍左右对比（展开态 + 右侧收起态）
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
// 关闭 Agent 免责弹窗
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('[role=dialog] button')]
  const use = btns.find(b => /继续使用/.test(b.innerText || ''))
  const never = btns.find(b => /不再提示/.test(b.innerText || ''))
  if (never) never.click()
  if (use) use.click()
})
await page.waitForTimeout(1000)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-expanded.png' })
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-collapse-btn]')?.click())
await page.waitForTimeout(800)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-collapsed.png' })
await browser.close()
console.log('DONE')
