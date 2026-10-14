import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadChromium } from '../products/bosom-friend/qa/browser.mjs'

const outDir = process.argv[2]
mkdirSync(outDir, { recursive: true })
const base = 'http://127.0.0.1:31280/bosom-friend/'
const chromium = loadChromium()
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const log = []

/** 每个画面独立上下文：AI 助手临时会话按启动清理，避免上一页的对话串进下一张图。 */
async function withPage(hash, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' })
  const page = await ctx.newPage()
  page.on('pageerror', e => log.push('pageerror: ' + String(e).slice(0, 200)))
  let ok = false
  for (let i = 0; i < 4 && !ok; i++) {
    await page.goto(base + hash, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(4500)
    ok = (await page.locator('text=系统出现了错误').count()) === 0
    if (!ok) { log.push(hash + ' error-boundary retry ' + i); await page.waitForTimeout(4000) }
  }
  try { await fn(page) } catch (e) { log.push(hash + ' -> ' + e.message.slice(0, 140)) }
  await ctx.close()
}
/** 按「文本完全相等」找到最小可见元素并点它的中心（顶部标签靠角点点不中）。 */
async function clickByText(page, text) {
  const box = await page.evaluate((t) => {
    const all = Array.from(document.querySelectorAll('button, a, div, span, li'))
    const hits = all.filter(el => (el.textContent || '').trim() === t)
    if (!hits.length) return null
    hits.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)
    const r = hits[0].getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return null
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, text)
  if (!box) throw new Error('not found: ' + text)
  await page.mouse.click(box.x, box.y)
  await page.waitForTimeout(2500)
}
async function shot(page, name) {
  await page.screenshot({ path: join(outDir, name + '.png') })
  console.log('captured ' + name)
}

await withPage('#/accounts', async (page) => {
  await page.locator('text=接待规则').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(1800)
  await shot(page, '17-reception-rules')
})
await withPage('#/ai-interaction', async (page) => {
  await clickByText(page, '评论搜索')
  await shot(page, '20-comment-search')
})
await withPage('#/tasks-history', async (page) => {
  await clickByText(page, '你好')
  await page.waitForTimeout(2000)
  await shot(page, '21-task-detail')
})
await withPage('#/settings', async (page) => {
  await clickByText(page, '自定义大模型'); await shot(page, '22-settings-llm')
  await clickByText(page, '系统与更新'); await shot(page, '23-settings-system')
  await clickByText(page, '远程访问'); await shot(page, '24-settings-remote')
})
console.log('LOG: ' + JSON.stringify(log, null, 1))
await browser.close()
