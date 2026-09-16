// probe-input.mjs - 测量右侧面板 ChatInput 实际几何
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(13000)
await page.evaluate(() => {
  const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || ''))
  if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click() }
  document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' })
})
await page.waitForTimeout(400)
const info = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]')
  const chat = aside ? aside.querySelector('textarea') : null
  const root = chat ? chat.closest('div[class*="rounded-2xl"]') : null
  const card = root ? root.querySelector('div.flex-1') : null
  const row = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { tag: el.tagName, c: (el.className || '').toString().slice(0, 60), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], h: cs.height, minH: cs.minHeight, maxH: cs.maxHeight, flexBasis: cs.flexBasis, flex: cs.flex } }
  return JSON.stringify({ aside: row(aside), chatRoot: row(root), textareaCard: row(card), textarea: row(chat), buttons: row(root ? [...root.querySelectorAll('button')].at(-1) : null) })
})
console.log(info)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/input-debug.png' })
await browser.close()
console.log('DONE')
