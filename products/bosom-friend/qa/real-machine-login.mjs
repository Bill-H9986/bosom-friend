// 真机小红书登录：打开真实 Chrome，显示官方二维码，等待扫码后账号落盘。
import { createRequire } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const LOG = join(import.meta.dirname, 'real-machine-login-events.jsonl')
const BASE = 'http://127.0.0.1:3080/bosom-friend/'
const API = 'http://127.0.0.1:3080/bosom-friend/api/'

function log(type, detail = '') {
  const line = JSON.stringify({ time: new Date().toISOString(), type, detail: String(detail).slice(0, 1200) })
  appendFileSync(LOG, line + '\n', 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
log('start', 'real chrome login driver')

const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', error => errors.push(String(error)))

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000)
  log('page-loaded', page.url())

  try {
    await page.locator("button:has-text('我已阅读并同意')").click({ timeout: 10000 })
    await page.locator("button:has-text('同意并进入平台')").click({ timeout: 10000 })
    await page.waitForTimeout(2500)
  } catch { /* already agreed */ }

  await page.locator('[data-testid=sidebar-account-entry]').click({ timeout: 10000 })
  await page.waitForSelector('[data-testid=channel-manager-dialog]', { timeout: 15000 })
  await page.waitForTimeout(2000)

  let connectClicked = false
  if (await page.locator('[data-testid=cm-sidebar-connect-btn]').count() > 0) {
    await page.locator('[data-testid=cm-sidebar-connect-btn]').first().click({ timeout: 6000 })
    connectClicked = true
  } else if (await page.locator('[data-testid=cm-space-add-channel-btn]').count() > 0) {
    await page.locator('[data-testid=cm-space-add-channel-btn]').first().click({ timeout: 6000 })
    connectClicked = true
  }
  if (!connectClicked) throw new Error('connect entry not found')

  await page.waitForSelector('[data-testid=cm-connect-list]', { timeout: 15000 })
  const xhsCard = page.locator('[data-testid=cm-connect-platform-card]').filter({ hasText: '小红书' }).first()
  await xhsCard.click({ timeout: 10000 })
  log('auth-started', 'xhs QR flow')

  await page.waitForSelector('[data-testid=cm-auth-countdown], [data-testid=cm-auth-loading]', { timeout: 30000 })
  const qrText = await page.locator('[data-testid=cm-auth-countdown], [data-testid=cm-auth-loading]').first().innerText().catch(() => '')
  log('auth-page', qrText)
  log('scan-required', '请在打开的真实 Chrome 窗口扫码')

  let loggedIn = false
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(2000)
    const res = await (await fetch(API + 'v2/channels/accounts')).json()
    if ((res?.data?.list ?? []).length > 0) {
      loggedIn = true
      log('login-success', JSON.stringify(res.data.list.map(a => ({ type: a.type, nick: a.nickname, uid: a.uid, status: a.status }))))
      break
    }
    if (i % 15 === 0) log('waiting-scan', `${i * 2}s`)
  }

  if (!loggedIn) {
    log('timeout', 'no account after 6 minutes')
    process.exitCode = 2
  }
} catch (error) {
  log('fatal', String(error))
  process.exitCode = 1
} finally {
  log('errors', errors.join(' | '))
  await browser.close()
}
