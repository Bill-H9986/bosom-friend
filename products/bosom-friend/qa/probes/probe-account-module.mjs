/**
 * 账号管理模块行为探针（debug 用，不参与门禁）。
 *
 * 目的：在写断言之前，先看清「刷新粉丝数 / 单账号刷新 / 限频 / 账号页状态」在真实
 * 运行时到底发了哪些请求、给了哪些提示，避免用页面文案凑断言。
 *
 * 用法：node products/bosom-friend/qa/probes/probe-account-module.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const calls = []
const toasts = []

async function acceptDisclaimer(page) {
  for (let i = 0; i < 6; i++) {
    const button = page.locator("button:has-text('我已阅读并同意')").first()
    if (await button.count() > 0 && await button.isVisible().catch(() => false))
      await button.click({ timeout: 4000 }).catch(() => {})
    const enter = page.locator("button:has-text('同意并进入平台')").first()
    if (await enter.count() > 0 && await enter.isVisible().catch(() => false))
      await enter.click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(400)
  }
}

async function drainToasts(page, label, ms) {
  const started = Date.now()
  const seen = new Set()
  while (Date.now() - started < ms) {
    const texts = await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => [])
    for (const t of texts) {
      const clean = t.replace(/\s+/g, ' ').trim()
      if (clean && !seen.has(clean)) {
        seen.add(clean)
        toasts.push({ label, text: clean })
        console.log('  [toast:' + label + '] ' + clean)
      }
    }
    await page.waitForTimeout(300)
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('response', async (response) => {
  const url = response.url()
  if (!url.includes('/bosom-friend/api/'))
    return
  if (!/channels|platform-sync/.test(url))
    return
  let code = null
  try { code = (await response.json())?.code ?? null } catch { /* 非 JSON 响应 */ }
  calls.push({ method: response.request().method(), url: url.replace(BASE, ''), status: response.status(), code })
})

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
await acceptDisclaimer(page)
await page.waitForTimeout(1000)

console.log('=== 打开频道管理 ===')
await page.locator('[data-testid=sidebar-account-entry]').click()
await page.waitForTimeout(3500)
const dialog = page.locator('[role=dialog]', { hasText: '频道管理' }).first()
await dialog.waitFor({ state: 'visible', timeout: 15000 })
console.log('dialog text:', (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 220))
console.log('channel rows:', await page.locator('[data-testid=cm-channel-item]:visible').count())
console.log('refresh-all btn:', await page.locator('[data-testid=cm-refresh-all-fans-btn]').count())
console.log('single refresh btn:', await page.locator('[data-testid=cm-channel-refresh-fans-btn]').count())
console.log('reauth btn:', await page.locator('[data-testid=cm-channel-reauth-btn]').count())

console.log('=== 点「刷新全部平台」 ===')
const before = calls.length
await page.locator('[data-testid=cm-refresh-all-fans-btn]').first().click()
await drainToasts(page, 'refresh-all', 20000)
console.log('requests:', JSON.stringify(calls.slice(before), null, 0))

console.log('=== 点单账号「刷新粉丝」 ===')
const before2 = calls.length
const single = page.locator('[data-testid=cm-channel-refresh-fans-btn]').first()
if (await single.count() > 0) {
  await single.click()
  await drainToasts(page, 'single-refresh', 20000)
  console.log('requests:', JSON.stringify(calls.slice(before2), null, 0))
}
else {
  console.log('单账号刷新按钮不存在，跳过')
}

console.log('=== 冷却记录 ===')
await page.keyboard.press('Escape')
await page.waitForTimeout(1200)
const cooldown = await page.evaluate(() => {
  const out = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.includes('cooldown'))
      out[k] = localStorage.getItem(k)
  }
  return out
})
console.log(JSON.stringify(cooldown))

console.log('=== 账号页 ===')
await page.goto(BASE + '?planId=mg-persist&_r=' + Date.now() + '#/accounts', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
const main = await page.locator('#main-content').first().innerText().catch(() => '')
console.log('main text:', main.replace(/\s+/g, ' ').slice(0, 400))
const pill = await page.locator('#main-content span').allInnerTexts().catch(() => [])
console.log('pills:', JSON.stringify(pill.filter(t => /正常|需重新登录|失效/.test(t))))

console.log('=== 全部 channels 请求 ===')
console.log(JSON.stringify(calls, null, 1))

await browser.close()
