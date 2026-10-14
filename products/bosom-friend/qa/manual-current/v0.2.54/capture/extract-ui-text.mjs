import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadChromium } from '../products/bosom-friend/qa/browser.mjs'

const outDir = process.argv[2]
mkdirSync(outDir, { recursive: true })
const base = 'http://127.0.0.1:31280/bosom-friend/'
const chromium = loadChromium()
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const result = {}

async function grab(name, hash, prep) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' })
  const page = await ctx.newPage()
  for (let i = 0; i < 4; i++) {
    await page.goto(base + hash, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(4500)
    if ((await page.locator('text=系统出现了错误').count()) === 0) break
    await page.waitForTimeout(4000)
  }
  if (prep) await prep(page)
  await page.waitForTimeout(2000)
  result[name] = await page.evaluate(() => document.body.innerText)
  await ctx.close()
  console.log('text ' + name)
}

const clickText = async (page, text) => {
  const box = await page.evaluate((t) => {
    const hits = Array.from(document.querySelectorAll('button, a, div, span, li')).filter(el => (el.textContent || '').trim() === t)
    if (!hits.length) return null
    hits.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)
    const r = hits[0].getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, text)
  if (!box) throw new Error('miss ' + text)
  await page.mouse.click(box.x, box.y)
  await page.waitForTimeout(2500)
}
const scrollAll = async (page) => {
  await page.evaluate(async () => {
    const el = Array.from(document.querySelectorAll('*')).filter(e => e.scrollHeight - e.clientHeight > 300 && e.clientHeight > 300).sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
    if (el) el.scrollTop = el.scrollHeight
  })
  await page.waitForTimeout(1500)
}

await grab('home', '#/')
await grab('draftbox', '#/draft-box', scrollAll)
await grab('materials', '#/draft-box', async p => { await clickText(p, '素材库'); await scrollAll(p) })
await grab('longvideo', '#/long-video', scrollAll)
await grab('digital-humans', '#/digital-humans', scrollAll)
await grab('ai-interaction', '#/ai-interaction', scrollAll)
await grab('comment-search', '#/ai-interaction', async p => { await clickText(p, '评论搜索') })
await grab('tasks', '#/tasks-history', scrollAll)
await grab('calendar', '#/calendar', scrollAll)
await grab('data', '#/data-statistics', scrollAll)
await grab('monitor', '#/monitor', scrollAll)
await grab('accounts', '#/accounts', scrollAll)
await grab('knowledge', '#/knowledge', scrollAll)
await grab('settings-general', '#/settings', scrollAll)
await grab('settings-llm', '#/settings', async p => { await clickText(p, '自定义大模型'); await scrollAll(p) })
await grab('settings-system', '#/settings', async p => { await clickText(p, '系统与更新'); await scrollAll(p) })
await grab('settings-remote', '#/settings', async p => { await clickText(p, '远程访问'); await scrollAll(p) })
await grab('publish-dialog', '#/draft-box', async p => { await p.locator('button:has-text("一键发布")').first().click({ timeout: 8000 }); await p.waitForTimeout(2500) })
await grab('channel-modal', '#/', async p => { await clickText(p, '添加频道') })
await grab('rule-modal', '#/accounts', async p => { await p.locator('button', { hasText: '新建规则' }).first().click({ timeout: 8000 }); await p.waitForTimeout(2500) })

writeFileSync(join(outDir, 'ui-text.json'), JSON.stringify(result, null, 1))
await browser.close()
