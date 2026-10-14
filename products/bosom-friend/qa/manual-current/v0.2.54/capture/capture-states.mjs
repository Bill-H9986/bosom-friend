import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadChromium } from '../products/bosom-friend/qa/browser.mjs'

const outDir = process.argv[2]
mkdirSync(outDir, { recursive: true })
const base = 'http://127.0.0.1:31280/bosom-friend/'
const chromium = loadChromium()
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' })
const page = await ctx.newPage()
const log = []

const ERROR_TEXT = '系统出现了错误'
async function healthy() {
  return (await page.locator('text=' + ERROR_TEXT).count()) === 0
}
/** 打开某个路由；撞上错误边界就重载重试（此处多次观察到一次性的瞬时崩溃）。 */
async function go(hash, tries = 4) {
  for (let i = 0; i < tries; i++) {
    await page.goto(base + hash, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(4500)
    if (await healthy()) return true
    log.push(hash + ' error-boundary, retry ' + (i + 1))
    await page.waitForTimeout(4000)
  }
  return false
}
async function shot(name) {
  if (!(await healthy())) { log.push('SKIP ' + name + ' (error page)'); return false }
  await page.screenshot({ path: join(outDir, name + '.png') })
  console.log('captured ' + name)
  return true
}
async function tabAt(x, y, name) {
  await page.mouse.click(x, y)
  await page.waitForTimeout(2500)
  await shot(name)
}

await go('#/')
await tabAt(90, 893, '15-channel-modal')
await page.keyboard.press('Escape'); await page.waitForTimeout(800)

await go('#/accounts')
await page.mouse.wheel(0, 1050); await page.waitForTimeout(2500)
await shot('17-reception-rules')
try {
  await page.locator('button', { hasText: '新建规则' }).first().click({ timeout: 8000 })
  await page.waitForTimeout(2500)
  await shot('19-rule-modal')
  await page.keyboard.press('Escape'); await page.waitForTimeout(800)
} catch (e) { log.push('rule-modal: ' + e.message.slice(0, 100)) }

await go('#/ai-interaction')
await tabAt(348, 52, '20-comment-search')

await go('#/tasks-history')
await tabAt(300, 170, '21-task-detail')

await go('#/settings')
await tabAt(348, 52, '22-settings-llm')
await tabAt(460, 52, '23-settings-system')
await tabAt(558, 52, '24-settings-remote')

if (await go('#/long-video')) {
  await page.mouse.wheel(0, 950); await page.waitForTimeout(3000)
  await shot('25-longvideo-shots')
}

console.log('LOG: ' + JSON.stringify(log, null, 1))
await browser.close()
