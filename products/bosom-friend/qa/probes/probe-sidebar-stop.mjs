/**
 * 右侧 AI 助手「停止」路径探针：确认侧栏停止会把服务端这次生成也中断。
 * 用法：node products/bosom-friend/qa/probes/probe-sidebar-stop.mjs
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const OUT = join(import.meta.dirname, 'agent-board')
const report = { base: BASE, at: new Date().toISOString() }

const api = async path => (await (await fetch(BASE + 'api/' + path)).json())
const taskById = async id => (await api('agent/tasks/' + id))?.data ?? null

async function acceptDisclaimer(page) {
  for (let i = 0; i < 8; i++) {
    for (const label of ['我已阅读并同意', '同意并进入平台']) {
      const button = page.locator(`button:has-text('${label}')`).first()
      if (await button.count() > 0 && await button.isVisible().catch(() => false))
        await button.click({ timeout: 3000 }).catch(() => {})
    }
    await page.waitForTimeout(400)
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(7000)
  await acceptDisclaimer(page)

  const panel = page.locator('[data-testid=ai-assistant-sidebar]').first()
  const newChat = panel.locator('button').filter({ hasText: /新对话/ }).first()
  report.newChatVisible = await newChat.count() > 0
  if (report.newChatVisible)
    await newChat.click().catch(() => {})
  await page.waitForTimeout(2000)

  const before = new Set(((await api('agent/tasks?page=1&pageSize=20'))?.data?.list ?? []).map(item => item.id))
  const input = panel.locator('textarea').first()
  await input.fill('请用三句话说明你今天能帮我做什么。')
  await panel.locator('button[aria-label="发送"]').last().click({ timeout: 15000 })

  const stop = panel.locator('button[aria-label="停止生成"]').last()
  report.stopVisible = await stop.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false)
  const fresh = ((await api('agent/tasks?page=1&pageSize=20'))?.data?.list ?? []).find(item => !before.has(item.id))
  report.taskId = fresh?.id ?? null
  report.statusWhileGenerating = fresh?.status ?? null
  if (report.stopVisible)
    await stop.click().catch(() => {})
  await page.waitForTimeout(6000)
  const after = report.taskId === null ? null : await taskById(report.taskId)
  report.statusAfterStop = after?.status ?? null
  report.assistantText = (after?.messages ?? []).filter(m => m.type === 'assistant').map(m => m.content ?? '').join(' | ').slice(-120)
  await page.screenshot({ path: join(OUT, '08-sidebar-stop.png') })
  console.log('SIDEBAR_STOP ' + JSON.stringify({ visible: report.stopVisible, taskId: report.taskId, status: report.statusAfterStop }))
}
catch (error) {
  report.error = String(error?.message ?? error).slice(0, 400)
  console.log('SIDEBAR_STOP ERROR ' + report.error)
}
writeFileSync(join(import.meta.dirname, 'probe-sidebar-stop-report.json'), JSON.stringify(report, null, 2), 'utf8')
await browser.close()
