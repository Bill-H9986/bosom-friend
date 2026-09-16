// probe-llm.mjs - 设置→AI 模型服务：无默认模型 UI + 保存流程 + 截图
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
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].filter(x => /自定义大模型/.test(x.innerText || '')); if (b[0]) b[0].click() })
await page.waitForTimeout(2200)
const before = await page.evaluate(() => ({
  keyCard: document.body.innerText.includes('使用你自己的 AI 钥匙'),
  agnesBtn: document.body.innerText.includes('去 Agnes AI 国内站领取钥匙'),
  needBadge: document.body.innerText.includes('未配置 · 需要你的钥匙'),
  noDefault: !document.body.innerText.includes('默认模型'),
  noSystem: !document.body.innerText.includes('已接通'),
  steps: document.body.innerText.includes('注册 Agnes 账号'),
  modelRequired: document.body.innerText.includes('没有默认模型'),
  saved: localStorage.getItem('bosom-friend-user-llm'),
}))
console.log('BEFORE:', JSON.stringify(before))
// 尝试：只填 Key 不填模型 → 应被拦截
await page.evaluate(() => {
  const set = (i, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })) }
  const inputs = [...document.querySelectorAll('input')]
  const key = inputs.find(i => i.placeholder === 'sk-...' && i.type === 'password')
  if (key) set(key, 'sk-no-model')
})
await page.waitForTimeout(300)
const attempt = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(x => /保存并使用我的钥匙/.test(x.innerText || ''))
  return btn ? btn.disabled : 'missing'
})
console.log('SAVE-NO-MODEL-DISABLED:', attempt)
// 补齐模型保存
await page.evaluate(() => {
  const set = (i, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })) }
  const model = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').startsWith('例：agnes'))
  if (model) set(model, 'agnes-2.5-flash')
})
await page.waitForTimeout(300)
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /保存并使用我的钥匙/.test(x.innerText || '')); if (b) b.click() })
await page.waitForTimeout(800)
const after = await page.evaluate(() => ({
  saved: localStorage.getItem('bosom-friend-user-llm'),
  badge: document.body.innerText.includes('已配置你自己的模型'),
  desc: (document.body.innerText.match(/当前使用你自己的模型[^。]*。/?.[0] || '')),
}))
console.log('AFTER:', JSON.stringify(after))
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/probes/llm-tab-clean.png' })
await browser.close()
console.log('DONE')
