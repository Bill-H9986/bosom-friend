// 契约验证：拦截真实发布请求，只检查 topics/media，不真正上传平台。
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = 'http://127.0.0.1:3080/bosom-friend/'
const API = 'http://127.0.0.1:3080/bosom-friend/api/'
const EXAM = '请帮我创作并发布一篇《关于无人机装调检修就业培训宣传》的小红书笔记，直接完成到发布，并同步账号数据和AI客服。'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
let captured = null

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(8000)
try {
  await page.locator("button:has-text('我已阅读并同意')").click({ timeout: 10000 })
  await page.locator("button:has-text('同意并进入平台')").click({ timeout: 10000 })
  await page.waitForTimeout(2500)
} catch { /* already agreed */ }

await page.route('**/v2/channels/publish/flows', async route => {
  captured = route.request().postDataJSON()
  await route.abort()
})

const input = page.locator('[data-testid=ai-assistant-sidebar] textarea, [data-testid=ai-assistant-sidebar] input').first()
await input.fill(EXAM)
await input.press('Enter')
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000)
  if (await page.locator('button:has-text("去发布")').count() > 0)
    break
}
await page.locator('button:has-text("去发布")').first().click({ timeout: 5000 })
await page.waitForTimeout(8000)
const submit = page.locator('[data-testid=publish-submit-btn]')
const dialogBefore = await page.locator('[role=dialog]').innerText().catch(() => '')
console.log('DIALOG_BEFORE', dialogBefore.replace(/\s+/g, ' ').slice(0, 1400))
await submit.click({ timeout: 10000 })
await page.waitForTimeout(3000)
const dialogAfter = await page.locator('[role=dialog]').innerText().catch(() => '')
console.log('DIALOG_AFTER', dialogAfter.replace(/\s+/g, ' ').slice(0, 1400))

const records = await (await fetch(API + 'v2/channels/publish/records')).json()
const content = captured?.content ?? {}
const mediaUrls = (content.media ?? []).map(media => media.url)
const uniqueMedia = new Set(mediaUrls).size
const result = {
  captured: !!captured,
  title: content.title,
  topics: content.topics ?? [],
  mediaCount: mediaUrls.length,
  mediaUnique: uniqueMedia,
  recordCountUnchanged: (records.data.records ?? []).length,
}
writeFileSync(join(import.meta.dirname, 'flow-verify.json'), JSON.stringify(result, null, 2), 'utf8')
console.log(JSON.stringify(result, null, 2))
await browser.close()
