// 真机考试驱动：打开真实 Chrome，给 APP 智能体出题并记录关键动作。
import { createRequire } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const LOG = join(import.meta.dirname, 'real-machine-events.jsonl')
const BASE = 'http://127.0.0.1:3080/bosom-friend/'
const EXAM = '请帮我创作并发布一篇《关于无人机装调检修就业培训宣传》的小红书笔记，直接完成到发布，并同步账号数据和AI客服。'

function log(type, detail = '') {
  const line = JSON.stringify({ time: new Date().toISOString(), type, detail })
  appendFileSync(LOG, line + '\n', 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
log('start', 'real chrome driver started')

const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', error => {
  errors.push(String(error))
  log('pageerror', String(error))
})
page.on('console', message => {
  if (message.type() === 'error')
    log('console-error', message.text())
})

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000)
  log('page-loaded', page.url())

  try {
    await page.locator("button:has-text('我已阅读并同意')").click({ timeout: 10000 })
    await page.locator("button:has-text('同意并进入平台')").click({ timeout: 10000 })
    await page.waitForTimeout(2500)
  }
  catch { /* already agreed */ }

  const input = page.locator('[data-testid=ai-assistant-sidebar] textarea, [data-testid=ai-assistant-sidebar] input').first()
  await input.fill(EXAM)
  await input.press('Enter')
  log('exam-sent', EXAM)

  let cardSeen = false
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000)
    const cardCount = await page.locator('button:has-text("去发布")').count()
    if (cardCount > 0) {
      cardSeen = true
      log('action-card', `去发布 count=${cardCount} after=${i + 1}s`)
      await page.locator('button:has-text("去发布")').first().click({ timeout: 5000 })
      await page.waitForTimeout(7000)
      const dialogText = await page.locator('[role=dialog]').innerText().catch(() => '')
      log('publish-dialog', dialogText.replace(/\s+/g, ' ').slice(0, 1200))
      break
    }
  }

  if (!cardSeen)
    log('action-card-missing', 'no 去发布 card in 40s')

  log('screen-final', await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 2000)))
}
catch (error) {
  log('fatal', String(error))
}

log('errors', errors.slice(0, 10).join(' | '))
await browser.close()
