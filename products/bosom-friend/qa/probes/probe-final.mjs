// probe-final.mjs - 右侧面板最终验证：紧凑头部 / 收起重叠替换 / 输入框高度
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
const expanded = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]')
  const logo = aside.querySelector('[data-testid=ai-assistant-compact-logo]')
  const btn = document.querySelector('[data-testid=ai-assistant-collapse-btn]')
  const ta = aside.querySelector('textarea')
  const root = ta ? ta.closest('div[class*="rounded-2xl"]') : null
  const ir = logo.querySelector('img').getBoundingClientRect()
  const br = btn.getBoundingClientRect()
  return JSON.stringify({ logoImg: [Math.round(ir.width)], word: logo.innerText.replace(/\s+/g, ''), btn: [Math.round(br.width), Math.round(br.height)], inputH: root ? Math.round(root.getBoundingClientRect().height) : null })
})
console.log('RIGHT-EXPANDED:', expanded)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/final-expanded.png' })
// 收起 → 重叠替换
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-collapse-btn]')?.click())
await page.waitForTimeout(800)
const coll = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]')
  const link = aside.querySelector('[data-testid=sidebar-logo-link]')
  const img = link.querySelector('img')
  const btn = document.querySelector('[data-testid=ai-assistant-expand-btn]')
  const ir = img.getBoundingClientRect(); const br = btn.getBoundingClientRect()
  const sameSpot = Math.abs((br.x + br.width / 2) - (ir.x + ir.width / 2)) <= 8 && Math.abs((br.y + br.height / 2) - (ir.y + ir.height / 2)) <= 8
  return JSON.stringify({ sameSpot, linkOpacity: parseFloat(getComputedStyle(link).opacity), btnOpacity: parseFloat(getComputedStyle(btn).opacity), imgW: Math.round(ir.width) })
})
console.log('RIGHT-COLLAPSED-IDLE:', coll)
await page.hover('[data-testid=ai-assistant-sidebar]')
await page.waitForTimeout(500)
const hov = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]')
  const link = aside.querySelector('[data-testid=sidebar-logo-link]')
  const btn = document.querySelector('[data-testid=ai-assistant-expand-btn]')
  return JSON.stringify({ linkOpacity: parseFloat(getComputedStyle(link).opacity), btnOpacity: parseFloat(getComputedStyle(btn).opacity) })
})
console.log('RIGHT-COLLAPSED-HOVER:', hov)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/final-collapsed-hover.png' })
await browser.close()
console.log('DONE')
