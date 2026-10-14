// 人工复核后固化视觉基线：仅记录稳定骨架（aside/nav），避免业务数据变化导致误报。
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const BASE = dirname(fileURLToPath(import.meta.url))
const fpFile = join(BASE, 'visual-baseline.json')
const prevFile = join(BASE, 'visual-baseline.prev.json')
const routes = ['#/', '#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts']

// 基址必须与门禁同口径（qa-guard2 用 BF_QA_BASE）：写死 3080 而实例在 31280 时，
// 这里采到的是**空页面**——基线会把"什么都没有"记成正确骨架，之后每次对比都 FAIL
// （2026-09-30 实测：rebaseline 后 VISUAL 仍红，根因就是这一行）。
const APP_BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto(APP_BASE, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForTimeout(7000)
const latest = {}
for (const route of routes) {
  await page.evaluate(value => { location.hash = value }, route)
  await page.waitForTimeout(3000)
  latest[route] = await page.evaluate(() => {
    const parts = []
    const els = document.querySelectorAll('aside, nav, [data-testid=sidebar-nav]')
    for (const el of [].slice.call(els).slice(0, 8)) {
      const r = el.getBoundingClientRect()
      parts.push([el.tagName, (el.className || '').toString().slice(0, 40), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])
    }
    return JSON.stringify(parts).slice(0, 400)
  })
}
writeFileSync(prevFile, JSON.stringify(JSON.parse(readFileSync(fpFile, 'utf8')), null, 2), 'utf8')
writeFileSync(fpFile, JSON.stringify(latest, null, 2), 'utf8')
console.log('visual baseline rebaselined with stable skeleton, previous saved to visual-baseline.prev.json')
await browser.close()
