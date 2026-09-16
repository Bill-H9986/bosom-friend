// probe-v1b.mjs - 左侧收起态 idle/hover 确认（鼠标移出侧栏后测 idle）
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
})
await page.waitForTimeout(600)
await page.evaluate(() => { document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' }) })
// 收起左侧
await page.evaluate(() => document.querySelector('[data-testid=sidebar-toggle-btn]')?.click())
await page.waitForTimeout(800)
await page.mouse.move(700, 450)
await page.waitForTimeout(500)
const idle = await page.evaluate(() => {
  const aside = document.querySelector('aside')
  const link = aside.querySelector('[data-testid=sidebar-logo-link]')
  const btn = document.querySelector('[data-testid=sidebar-toggle-btn]')
  const img = link.querySelector('img')
  const ir = img.getBoundingClientRect(); const br = btn.getBoundingClientRect()
  const sameSpot = Math.abs((br.x + br.width / 2) - (ir.x + ir.width / 2)) <= 8 && Math.abs((br.y + br.height / 2) - (ir.y + ir.height / 2)) <= 8
  return JSON.stringify({ sameSpot, linkOpacity: parseFloat(getComputedStyle(link).opacity), btnOpacity: parseFloat(getComputedStyle(btn).opacity) })
})
console.log('LEFT-IDLE:', idle)
await page.hover('aside')
await page.waitForTimeout(500)
const hov = await page.evaluate(() => {
  const aside = document.querySelector('aside')
  const link = aside.querySelector('[data-testid=sidebar-logo-link]')
  const btn = document.querySelector('[data-testid=sidebar-toggle-btn]')
  return JSON.stringify({ linkOpacity: parseFloat(getComputedStyle(link).opacity), btnOpacity: parseFloat(getComputedStyle(btn).opacity) })
})
console.log('LEFT-HOVER:', hov)
await browser.close()
console.log('DONE')
