// probe-input2.mjs - 多视口复现输入框几何
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const vp of [{ w: 1920, h: 1080 }, { w: 1366, h: 768 }, { w: 1024, h: 768 }, { w: 2560, h: 1440 }]) {
  const page = await (await browser.newContext({ viewport: { width: vp.w, height: vp.h } })).newPage()
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
    const aside = document.querySelector('[data-testid=ai-assistant-sidebar]')
    const chat = aside ? aside.querySelector('textarea') : null
    const root = chat ? chat.closest('div[class*="rounded-2xl"]') : null
    const r = root ? root.getBoundingClientRect() : null
    const t = chat ? chat.getBoundingClientRect() : null
    return JSON.stringify({ root: r ? [Math.round(r.width), Math.round(r.height), Math.round(r.y)] : null, ta: t ? [Math.round(t.height)] : null })
  })
  console.log(vp.w + 'x' + vp.h + ':', info)
  await page.close()
}
await browser.close()
console.log('DONE')
