// 真机发布考试驱动：发送题目、点击 AI 动作、提交发布、轮询真实平台结果。
import { createRequire } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const LOG = join(import.meta.dirname, 'real-machine-publish-events.jsonl')
const BASE = 'http://127.0.0.1:3080/bosom-friend/'
const APP = 'http://127.0.0.1:3080/bosom-friend/%EF%BC%88PID?planId=mg-persist'
const API = 'http://127.0.0.1:3080/bosom-friend/api/'
const EXAM = '请帮我创作并发布一篇《关于无人机装调检修就业培训宣传》的小红书笔记，直接完成到发布，并同步账号数据和AI客服。'

function log(type, detail = '') {
  const line = JSON.stringify({ time: new Date().toISOString(), type, detail: String(detail).slice(0, 1600) })
  appendFileSync(LOG, line + '\n', 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
log('start', 'real machine publish driver')

const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', error => {
  errors.push(String(error))
  log('pageerror', String(error))
})

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000)
  try {
    await page.locator("button:has-text('我已阅读并同意')").click({ timeout: 10000 })
    await page.locator("button:has-text('同意并进入平台')").click({ timeout: 10000 })
    await page.waitForTimeout(2500)
  } catch { /* already agreed */ }

  const input = page.locator('[data-testid=ai-assistant-sidebar] textarea, [data-testid=ai-assistant-sidebar] input').first()
  await input.fill(EXAM)
  await input.press('Enter')
  log('exam-sent', EXAM)

  let cardSeen = false
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000)
    if (await page.locator('button:has-text("去发布")').count() > 0) {
      cardSeen = true
      log('action-card', `after ${i + 1}s`)
      break
    }
  }
  if (!cardSeen) throw new Error('AI action card not generated')

  await page.locator('button:has-text("去发布")').first().click({ timeout: 5000 })
  await page.waitForTimeout(8000)
  const selectorCount = await page.locator('[data-testid=publish-account-selector]').count()
  const dialogText = await page.locator('[role=dialog]').innerText().catch(() => '')
  log('publish-dialog', dialogText.replace(/\s+/g, ' ').slice(0, 1600))
  if (selectorCount === 0) throw new Error('publish dialog has no account')
  if (dialogText.includes('请上传图片或视频')
    || dialogText.includes('还没有添加账户')
    || dialogText.includes('话题最多不能超过')
    || dialogText.includes('最多不能超过10个'))
    throw new Error('publish dialog invalid: ' + dialogText.replace(/\s+/g, ' ').slice(0, 220))

  const submit = page.locator('[data-testid=publish-submit-btn]')
  log('publish-submit', `accounts=${selectorCount}, enabled=${await submit.isEnabled()}`)
  await submit.click({ timeout: 10000 })
  await page.waitForTimeout(5000)
  log('submit-clicked', page.url())

  const startTime = Date.now()
  let publishedRecord = null
  while (Date.now() - startTime < 600000) {
    await page.waitForTimeout(3000)
    const records = await (await fetch(API + 'v2/channels/publish/records')).json()
    const recordsList = records?.data?.records ?? []
    const candidate = recordsList.find(r => r.title.includes('无人机') && r.publishTime >= new Date(Date.now() - 3600000).toISOString())
    if (candidate) {
      publishedRecord = candidate
      log('record-state', `id=${candidate.id} status=${candidate.status} error=${candidate.errorMsg || ''} link=${candidate.workLink || ''}`)
      if (candidate.status === 1) break
      if (candidate.status === -1) throw new Error('publish failed: ' + (candidate.errorMsg || 'unknown'))
    }
  }
  if (!publishedRecord || publishedRecord.status !== 1) throw new Error('publish did not succeed')

  log('publish-success', JSON.stringify({ id: publishedRecord.id, workLink: publishedRecord.workLink, title: publishedRecord.title }))
  const accounts = await (await fetch(API + 'v2/channels/accounts')).json()
  const dashboard = await (await fetch(API + 'v2/statistics/published-content-summary/dashboard')).json()
  log('verify-data', JSON.stringify({ accounts: accounts.data.list.map(a => ({ nick: a.nickname, uid: a.uid, workCount: a.workCount })), workCount: dashboard.data.overall.workCount }))
  const reception = await (await fetch(API + 'v2/customer-reception/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '请问什么时候发货', platform: 'xhs' }),
  })).json()
  log('verify-reception', JSON.stringify(reception.data))

  await page.goto(APP + '#/accounts', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  await page.goto(APP + '#/monitor', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: join(import.meta.dirname, 'real-machine-publish-final.png'), fullPage: true })
  log('final-page-ok', 'accounts+monitor loaded')
} catch (error) {
  log('fatal', String(error))
  process.exitCode = 1
} finally {
  log('errors', errors.slice(0, 10).join(' | '))
  await browser.close()
}
