// probe-perf.mjs - 验证 v5：FPS 实测 + 两帧变化 + 截图
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
await page.waitForTimeout(500)
// FPS：用 rAF 计数 3 秒
const fps = await page.evaluate(() => new Promise(resolve => {
  let frames = 0
  const t0 = performance.now()
  const tick = () => { frames++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve(Math.round(frames / ((performance.now() - t0) / 1000))) }
  requestAnimationFrame(tick)
}))
console.log('FPS:', fps)
const s1 = await page.evaluate(() => document.querySelector('[data-testid=logo-particle-field]')?.toDataURL() || '')
await page.waitForTimeout(5000)
const s2 = await page.evaluate(() => document.querySelector('[data-testid=logo-particle-field]')?.toDataURL() || '')
console.log('FLOWING:', s1 !== s2)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/logo-field-v5.png' })
await browser.close()
console.log('DONE')
