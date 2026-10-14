// 装机版全页走查（陌生人的眼睛）：按可见导航逐页打开、截图留档、记录页面错误与断图。
// 判定只认结构化信号：页面错误列表 + 每页非空文本长度 + 同源图片加载失败数。
// 用法：node products/bosom-friend/qa/field/installed-walkthrough.mjs [baseName]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const TAG = process.argv[2] || 'installed-0.4.0'
const OUT = join(import.meta.dirname, '..', 'evidence', TAG + '-walkthrough')
mkdirSync(OUT, { recursive: true })

const ROUTES = [
  ['首页', '#/'],
  ['内容创作', '#/draft-box'],
  ['我的任务', '#/tasks-history'],
  ['AI 对话', '#/ai-interaction'],
  ['知识库', '#/knowledge'],
  ['日历', '#/calendar'],
  ['数据中心', '#/data-statistics'],
  ['全局监控', '#/monitor'],
  ['设置', '#/settings'],
  ['账号管理', '#/accounts'],
]

const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e)))

const results = []
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000)
  try {
    await page.locator("button:has-text('我已阅读并同意')").click({ timeout: 6000 })
    await page.locator("button:has-text('同意并进入平台')").click({ timeout: 6000 })
    await page.waitForTimeout(2000)
  } catch { /* 已同意 */ }

  for (const [label, hash] of ROUTES) {
    const before = pageErrors.length
    await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3500)
    const text = (await page.evaluate(() => document.body ? document.body.innerText : '')).replace(/\s+/g, ' ').trim()
    const brokenLocal = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'))
      return imgs.filter(i => i.complete && i.naturalWidth === 0 && new URL(i.src, location.href).origin === location.origin).length
    })
    const shot = join(OUT, hash.replace(/[#/]/g, '_') + '.png')
    await page.screenshot({ path: shot, fullPage: true })
    results.push({ label, hash, textLen: text.length, brokenLocal, newErrors: pageErrors.length - before, shot })
  }
} finally {
  const bad = results.filter(r => r.textLen < 120 || r.brokenLocal > 0 || r.newErrors > 0)
  console.log('WALKTHROUGH ' + (bad.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL')
    + ' pages=' + results.length + ' bad=' + bad.length + ' pageErrors=' + pageErrors.length)
  for (const r of results) console.log('  ' + r.label + ' len=' + r.textLen + ' brokenImg=' + r.brokenLocal + ' err=' + r.newErrors)
  if (pageErrors.length > 0) console.log('  pageErrors: ' + pageErrors.slice(0, 3).join(' | ').slice(0, 400))
  writeFileSync(join(OUT, 'walkthrough.json'), JSON.stringify({ base: BASE, results, pageErrors }, null, 2), 'utf8')
  await browser.close()
}
if (results.some(r => r.textLen < 120 || r.brokenLocal > 0 || r.newErrors > 0) || pageErrors.length > 0) process.exitCode = 1
