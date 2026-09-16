// probe-ota.mjs - 打开设置→系统与升级 截图 + 断言
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
await page.evaluate(() => { location.hash = '#/settings' })
await page.waitForTimeout(3000)
// 点开「系统与更新」标签
const clicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')].filter(b => /系统与更新/.test(b.innerText || ''))
  if (btns[0]) { btns[0].click(); return true }
  return false
})
console.log('tab clicked:', clicked)
await page.waitForTimeout(1200)
const info = await page.evaluate(() => {
  const t = document.body.innerText
  const has = (s) => t.includes(s)
  return JSON.stringify({
    version: has('当前版本'), latest: has('已是最新版本'), v: has('v0.13.5'),
    infoCard: has('产品信息'), faq: has('常见问题'), secure: has('数据安全'),
    devOpt: has('开发者选项'), ota: has('OTA 远程升级'), invoke: !!(window.ipcRenderer && window.ipcRenderer.invoke)
  })
})
console.log('STATE:', info)
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/probes/ota-tab.png' })
await browser.close()
console.log('DONE')
