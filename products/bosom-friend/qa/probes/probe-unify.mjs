// probe-unify.mjs - 右侧 AI 助手面板 Logo/收起按钮与左侧逐字一致性验证
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)

const geom = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), opacity: getComputedStyle(el).opacity }
}, sel)

const sideSidebar = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]')
  if (!aside) return 'NO RIGHT ASIDE'
  const link = aside.querySelector('[data-testid=sidebar-logo-link]')
  if (!link) return 'NO LOGO LINK'
  const img = link.querySelector('img')
  const text = link.innerText.replace(/\s+/g, '')
  const lr = link.getBoundingClientRect()
  const ar = aside.getBoundingClientRect()
  return JSON.stringify({
    imgW: img ? Math.round(img.getBoundingClientRect().width) : null,
    text, centered: Math.abs((lr.x + lr.width / 2) - (ar.x + ar.width / 2)) <= 10,
    layoutVertical: img && lr.height > lr.width * 1.2,
  })
})
console.log('RIGHT-EXPANDED:', sideSidebar)
const rightBtn = await geom('[data-testid=ai-assistant-collapse-btn]')
const rightLink = await geom('[data-testid=ai-assistant-sidebar] [data-testid=sidebar-logo-link]')
if (rightBtn && rightLink) {
  const overlap = !(rightBtn.x + rightBtn.w <= rightLink.x || rightBtn.x >= rightLink.x + rightLink.w || rightBtn.y + rightBtn.h <= rightLink.y || rightBtn.y >= rightLink.y + rightLink.h)
  console.log('RIGHT-EXPANDED-BTN:', JSON.stringify({ btn: rightBtn, link: rightLink, overlap }))
}
const leftBtn = await geom('[data-testid=sidebar-toggle-btn]')
const leftImg = await geom('[data-testid=sidebar-logo-link] img')
const rightImg = await geom('[data-testid=ai-assistant-sidebar] [data-testid=sidebar-logo-link] img')
console.log('COMPARE-EXPANDED:', JSON.stringify({ leftImg, rightImg, leftBtn, rightBtn }))
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-expanded.png' })

// 收起右侧
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-collapse-btn]')?.click())
await page.waitForTimeout(800)
const rImg = await geom('[data-testid=ai-assistant-sidebar] [data-testid=sidebar-logo-link] img')
const rBtn = await geom('[data-testid=ai-assistant-expand-btn]')
console.log('RIGHT-COLLAPSED:', JSON.stringify({ img: rImg, btn: rBtn, below: rBtn && rImg ? rBtn.y >= rImg.y + rImg.h - 2 : null, overlap: rBtn && rImg ? !(rBtn.x + rBtn.w <= rImg.x || rBtn.x >= rImg.x + rImg.w || rBtn.y + rBtn.h <= rImg.y || rBtn.y >= rImg.y + rImg.h) : null }))
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-collapsed.png' })

// 再展开恢复
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-expand-btn]')?.click())
await page.waitForTimeout(600)
const back = await geom('[data-testid=ai-assistant-collapse-btn]')
console.log('RE-EXPANDED:', JSON.stringify(back))
await browser.close()
