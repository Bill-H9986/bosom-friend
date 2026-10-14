import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadChromium } from '../products/bosom-friend/qa/browser.mjs'

const outDir = process.argv[2] ?? 'capture'
const base = 'http://127.0.0.1:31280/bosom-friend/'
const only = process.argv[3] ? process.argv[3].split(',') : null

const PAGES = [
  ['01-home', '#/'],
  ['02-draftbox', '#/draft-box'],
  ['03-longvideo', '#/long-video'],
  ['04-digital-humans', '#/digital-humans'],
  ['05-ai-interaction', '#/ai-interaction'],
  ['06-tasks', '#/tasks-history'],
  ['07-calendar', '#/calendar'],
  ['08-data', '#/data-statistics'],
  ['09-monitor', '#/monitor'],
  ['10-accounts', '#/accounts'],
  ['11-knowledge', '#/knowledge'],
  ['12-settings', '#/settings'],
]

mkdirSync(outDir, { recursive: true })
const chromium = loadChromium()
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
})
const page = await ctx.newPage()
/** 关掉可能挡住界面的弹窗（首次启动免责声明等），点不到就跳过。 */
async function dismissModals() {
  for (const label of ['我已知晓', '同意', '知道了', '我知道了', '确定']) {
    const btn = page.locator('button:has-text("' + label + '")').first()
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(600)
    }
  }
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(300)
}

const texts = {}
for (const [name, hash] of PAGES) {
  if (only && !only.includes(name)) continue
  await page.goto(base + hash, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(4500)
  await dismissModals()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(outDir, name + '.png') })
  texts[name] = await page.evaluate(() => document.body.innerText)
  console.log('captured ' + name)
}
writeFileSync(join(outDir, 'texts.json'), JSON.stringify(texts, null, 1))
await browser.close()
