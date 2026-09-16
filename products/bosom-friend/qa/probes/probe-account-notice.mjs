/**
 * 账号刷新反馈探针：确认「刷新粉丝数」的成功/限频反馈到底渲染成什么、文案是什么。
 * 用法：node products/bosom-friend/qa/probes/probe-account-notice.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const requests = []

const NOTICE = 'div.fixed.top-4.right-4 [role=status]'

async function acceptDisclaimer(page) {
  for (let i = 0; i < 6; i++) {
    for (const text of ['我已阅读并同意', '同意并进入平台']) {
      const button = page.locator('button:has-text(' + JSON.stringify(text) + ')').first()
      if (await button.count() > 0 && await button.isVisible().catch(() => false))
        await button.click({ timeout: 4000 }).catch(() => {})
    }
    await page.waitForTimeout(400)
  }
}

async function drain(page, label, ms) {
  const started = Date.now()
  const seen = new Set()
  while (Date.now() - started < ms) {
    const notices = await page.locator(NOTICE).allInnerTexts().catch(() => [])
    const toasts = await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => [])
    for (const [kind, list] of [['notice', notices], ['toast', toasts]]) {
      for (const raw of list) {
        const clean = raw.replace(/\s+/g, ' ').trim()
        if (!clean) continue
        const key = kind + ':' + clean
        if (seen.has(key)) continue
        seen.add(key)
        console.log('  [' + label + '/' + kind + '] ' + clean)
      }
    }
    await page.waitForTimeout(300)
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('response', async (response) => {
  const url = response.url()
  if (!/\/bosom-friend\/api\/v2\/channels/.test(url))
    return
  let code = null
  try { code = (await response.json())?.code ?? null } catch { /* 非 JSON */ }
  requests.push(response.request().method() + ' ' + url.replace(BASE, '') + ' -> ' + response.status() + '/code=' + code)
})

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
await acceptDisclaimer(page)
await page.locator('[data-testid=sidebar-account-entry]').click()
await page.waitForTimeout(3500)

console.log('=== 第一次「刷新全部平台」（应为成功/提交） ===')
await page.locator('[data-testid=cm-refresh-all-fans-btn]').first().click()
await drain(page, 'refresh-all-1', 20000)

console.log('=== 紧接着单账号「刷新粉丝」（同一平台已在冷却窗口内） ===')
const single = page.locator('[data-testid=cm-channel-refresh-fans-btn]').first()
if (await single.count() > 0) {
  const before = requests.length
  await single.click()
  await drain(page, 'single-2', 15000)
  console.log('  新增请求: ' + (requests.length - before))
}
else {
  console.log('  单账号刷新按钮不存在')
}

console.log('=== 再点一次「刷新全部平台」（全平台冷却） ===')
await page.locator('[data-testid=cm-refresh-all-fans-btn]').first().click()
await drain(page, 'refresh-all-3', 15000)

console.log('=== 通知容器选择器命中数 ===')
console.log('  notice nodes: ' + await page.locator(NOTICE).count())
console.log('  toast nodes: ' + await page.locator('[data-sonner-toast]').count())

console.log('=== 请求 ===')
for (const r of requests) console.log('  ' + r)

await browser.close()
