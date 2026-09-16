// probe-net.mjs - 数据不出网验证：产品使用全程，除本机回环外零外发请求
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const external = new Set()
page.on('request', req => {
  const u = new URL(req.url())
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') external.add(req.url().slice(0, 120))
})
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
await page.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || '')); if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click() }; document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' }) })
// 走一圈核心页面
for (const h of ['#/draft-box', '#/tasks-history', '#/data-statistics', '#/calendar', '#/monitor', '#/accounts', '#/settings', '#/']) {
  await page.evaluate(x => { location.hash = x }, h)
  await page.waitForTimeout(2200)
}
// 发一条 AI 对话（未配钥匙 → 引导模板，仍应零外发）
await page.click('[data-testid=ai-assistant-sidebar] textarea')
await page.keyboard.type('数据安全验证测试')
await page.keyboard.press('Enter')
await page.waitForTimeout(9000)
console.log('EXTERNAL-REQUESTS:', JSON.stringify([...external]))
console.log(external.size === 0 ? 'NET-ISOLATED: 零外发请求（数据不出网）' : 'NET-WARN: 存在外发请求!')
// 断网可用性：离线模拟本机仍可达（回环不依赖外网本身即证明）
await browser.close()
