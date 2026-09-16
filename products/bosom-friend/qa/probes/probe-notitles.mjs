// probe-notitles.mjs - 各功能页无左上角标题验证 + 截图
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
const routes = ['#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts']
for (const rr of routes) {
  await page.evaluate(r2 => { location.hash = r2 }, rr)
  await page.waitForTimeout(3200)
  const v = await page.evaluate(() => {
    const title = document.querySelector('[class*=page-title]')
    const h1s = [...document.querySelectorAll('h1')].map(h => (h.innerText || '').slice(0, 24))
    const aside = document.querySelector('main, [class*=page-shell]')
    const first = aside && aside.firstElementChild ? [aside.firstElementChild.tagName, (aside.firstElementChild.className || '').toString().slice(0, 50)] : null
    return { pageTitle: title ? title.innerText : null, h1s, first }
  })
  console.log(rr, '=>', JSON.stringify(v))
}
await page.evaluate(r2 => { location.hash = r2 }, '#/accounts')
await page.waitForTimeout(3200)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/accounts-no-title.png' })
await page.evaluate(r2 => { location.hash = r2 }, '#/draft-box')
await page.waitForTimeout(3200)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/draftbox-no-title.png' })
await browser.close()
console.log('DONE')
