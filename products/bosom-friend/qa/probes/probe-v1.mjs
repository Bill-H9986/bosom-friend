// probe-v1.mjs - 重叠替换版验证：收起态按钮与 logo 同位置交替（左右两侧）
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(13000)
// 关闭 Agent 提示弹窗并隐藏残留 backdrop
await page.evaluate(() => {
  const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || ''))
  if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click() }
})
await page.waitForTimeout(600)
await page.evaluate(() => {
  document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' })
})
await page.waitForTimeout(300)
const measure = (side) => page.evaluate((s) => {
  const asideSel = s === 'right' ? '[data-testid=ai-assistant-sidebar]' : 'aside'
  const btnSel = s === 'right' ? '[data-testid=ai-assistant-expand-btn]' : '[data-testid=sidebar-toggle-btn]'
  const aside = document.querySelector(asideSel)
  const link = aside ? aside.querySelector('[data-testid=sidebar-logo-link]') : null
  const img = link ? link.querySelector('img') : null
  const btn = document.querySelector(btnSel)
  if (!img || !btn) return 'MISSING'
  const ir = img.getBoundingClientRect()
  const br = btn.getBoundingClientRect()
  const sameSpot = Math.abs((br.x + br.width / 2) - (ir.x + ir.width / 2)) <= 8 && Math.abs((br.y + br.height / 2) - (ir.y + ir.height / 2)) <= 8
  const sameArea = !(br.right <= ir.left || br.left >= ir.right || br.bottom <= ir.top || br.top >= ir.bottom)
  return JSON.stringify({
    img: [Math.round(ir.x), Math.round(ir.y), Math.round(ir.width), Math.round(ir.height)],
    btn: [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)],
    sameSpot, sameArea,
    linkOpacity: parseFloat(getComputedStyle(link).opacity),
    btnOpacity: parseFloat(getComputedStyle(btn).opacity),
  })
}, side)
// 收起右侧
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-collapse-btn]')?.click())
await page.waitForTimeout(800)
console.log('RIGHT-COLLAPSED-IDLE:', await measure('right'))
await page.hover('[data-testid=ai-assistant-sidebar]')
await page.waitForTimeout(500)
console.log('RIGHT-COLLAPSED-HOVER:', await measure('right'))
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-collapsed-hover.png' })
await page.mouse.move(10, 450)
await page.waitForTimeout(500)
console.log('RIGHT-COLLAPSED-IDLE2:', await measure('right'))
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/unify-collapsed.png' })
// 收起左侧（对比参照）
await page.evaluate(() => document.querySelector('[data-testid=sidebar-toggle-btn]')?.click())
await page.waitForTimeout(800)
console.log('LEFT-COLLAPSED-IDLE:', await measure('left'))
await page.hover('aside')
await page.waitForTimeout(500)
console.log('LEFT-COLLAPSED-HOVER:', await measure('left'))
await browser.close()
console.log('DONE')
