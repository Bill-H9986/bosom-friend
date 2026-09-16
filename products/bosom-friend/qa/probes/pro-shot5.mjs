// pro-shot5.mjs - 最终对比截图（hide 循环兜住延迟弹窗）
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
const hide = () => page.evaluate(() => {
  let n = 0
  document.querySelectorAll('body > *, #root > *').forEach(d => { if ((d.innerText || '').includes('温馨提示')) { d.setAttribute('style', 'display:none !important'); n++ } })
  return n
})
// 等待并反复隐藏，直到弹窗出现且被隐藏
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(1600)
  const n = await hide()
  console.log('hide round', i, 'n=', n)
  if (n > 0) break
}
await page.waitForTimeout(400)
await hide()
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-expanded.png' })
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-collapse-btn]')?.click())
await page.waitForTimeout(800)
await hide()
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-collapsed.png' })
await browser.close()
console.log('DONE')
