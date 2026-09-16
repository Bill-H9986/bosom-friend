import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = 'http://127.0.0.1:3080/bosom-friend/'
const OUT = join(process.cwd(), 'tools', 'live-flow', 'shots')
mkdirSync(OUT, { recursive: true })
const PROMPT = '人社局无人机装调检修招工了！技术员在明亮车间调试无人机，科技感，写实'
let seq = 0
async function snap(page, label) {
  const file = join(OUT, `${String(seq++).padStart(2, '0')}-${label}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log('SHOT', file)
  return file
}
async function acceptDisclaimer(page) {
  for (let i = 0; i < 8; i++) {
    const d = page.locator('[role=dialog]').filter({ hasText: '免责声明' }).first()
    if (await d.count() > 0 && await d.isVisible().catch(() => false)) {
      const a = d.locator("button:has-text('我已阅读并同意')").first()
      if (await a.count() > 0) await a.click({ timeout: 3000 }).catch(() => {})
      const b = d.locator("button:has-text('同意并进入平台')").first()
      if (await b.count() > 0) await b.click({ timeout: 3000 }).catch(() => {})
    }
    await page.waitForTimeout(300)
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const net = []
page.on('request', r => { if (r.url().includes('/bosom-friend/api/ai/draft-generation')) net.push({ t: Date.now(), m: r.method(), u: r.url() }) })

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)
await acceptDisclaimer(page)
await snap(page, '000-home')

// ---- A1: 内容创作 生成图片 ----
await page.goto(BASE + '?planId=mg-persist#/draft-box', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(8000)
await acceptDisclaimer(page)
await page.locator('button:has-text("生成草稿(视频)")').first().click({ timeout: 8000 })
await page.waitForTimeout(2000)
await snap(page, 'a1-generation-dialog')
const controls = await page.evaluate(() => {
  const dlg = document.querySelector('[role=dialog]')
  if (!dlg) return { inputs: [], buttons: [] }
  return {
    inputs: Array.from(dlg.querySelectorAll('textarea, input, [contenteditable=true]')).map(e => ({ tag: e.tagName, ph: e.getAttribute('placeholder') || '', type: e.getAttribute('type') || '' })),
    buttons: Array.from(dlg.querySelectorAll('button')).map(b => (b.innerText || '').trim()).filter(Boolean),
  }
})
console.log('DIALOG_CONTROLS', JSON.stringify(controls))
let filled = false
if (controls.inputs.length) {
  const t = page.locator('[role=dialog] textarea, [role=dialog] input[type=text], [role=dialog] [contenteditable=true]').first()
  await t.fill(PROMPT).catch(() => page.locator('[role=dialog] [contenteditable=true]').first().click().then(() => page.keyboard.type(PROMPT)).catch(() => {}))
  filled = true
}
await snap(page, 'a2-filled')
const genBtn = page.locator('[role=dialog] button:has-text("生成图片")').first()
if (await genBtn.count() > 0) {
  await genBtn.click({ timeout: 8000 })
  console.log('clicked 生成图片')
} else {
  const createBtn = page.locator('[role=dialog] button:has-text("生成草稿(图文)")').first()
  if (await createBtn.count() > 0) await createBtn.click({ timeout: 8000 })
}
await snap(page, 'a3-submitted')
await page.waitForTimeout(15000)
console.log('NET_AFTER_IMAGE', JSON.stringify(net))
await snap(page, 'a4-image-waiting')
// 等待生成任务完成（最多 150 秒），观察页面是否出现带图片的生成记录
let imageEvidence = false
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(5000)
  const body = await page.evaluate(() => document.body.innerText)
  if (body.includes('生成记录') && (body.includes('已完成') || body.includes('成功'))) {
    imageEvidence = true
    break
  }
}
await snap(page, 'a5-image-result')
const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
console.log('IMAGE_EVIDENCE', imageEvidence, 'BODY_TAIL', body.slice(-400))

// ---- C: 数据中心实时数据 ----
await page.goto(BASE + '?planId=mg-persist#/data-statistics', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
await acceptDisclaimer(page)
const before = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
await snap(page, 'c1-datacenter-before')
const sync = page.locator('button:has-text("同步数据")').first()
await sync.click({ timeout: 8000 }).catch(() => {})
await page.waitForTimeout(15000)
const after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
await snap(page, 'c2-datacenter-after')
console.log('SYNC_CHANGED', before !== after, 'AFTER_TAIL', after.slice(-300))

// ---- 数据文件核对 ----
writeFileSync(join(OUT, 'full-audit-summary.json'), JSON.stringify({ net, filled, imageEvidence, syncChanged: before !== after }, null, 2), 'utf8')
await browser.close()
