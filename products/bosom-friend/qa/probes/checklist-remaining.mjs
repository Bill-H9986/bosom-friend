#!/usr/bin/env node
/** 清单 3-6 综合探针：账号页刷新/退出逻辑、AI客服配置与轮询、智能体对话。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 120000 })
  const log = []
  // 账号管理
  await page.locator('[data-testid="sidebar-account-entry"]').first().click().catch(() => {})
  await page.waitForTimeout(2000)
  const accountsText = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ').slice(0, 500)
  log.push('ACCOUNTS=' + accountsText)
  const refresh = page.getByText(/检测登录状态|刷新|同步/, { exact: false }).first()
  if (await refresh.isVisible({ timeout: 3000 }).catch(() => false)) {
    await refresh.click()
    await page.waitForTimeout(2500)
    log.push('REFRESH_CLICKED')
  } else {
    log.push('REFRESH_NOT_FOUND')
  }
  const logout = page.getByText(/退出|登出|注销/, { exact: false }).first()
  log.push('LOGOUT_BUTTON_VISIBLE=' + (await logout.isVisible({ timeout: 2000 }).catch(() => false)))
  await page.screenshot({ path: join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04/accounts.png') }).catch(() => {})
  // AI 客服（全局监控/接待）
  await page.getByText('全局监控', { exact: true }).first().click().catch(() => {})
  await page.waitForTimeout(2000)
  const monitorText = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ').slice(0, 600)
  log.push('MONITOR=' + monitorText)
  const poll = page.getByText(/立即|轮询|检测|刷新/, { exact: false }).first()
  if (await poll.isVisible({ timeout: 3000 }).catch(() => false)) {
    await poll.click()
    await page.waitForTimeout(2500)
    log.push('MONITOR_POLL_CLICKED')
  }
  await page.screenshot({ path: join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04/monitor.png') }).catch(() => {})
  // 智能体：发送需求并观察回复/动作卡
  const input = page.locator('[placeholder*="输入你的需求"]').first()
  if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
    await input.fill('请以“关于人社局无人机装调检修工程师就业免费培训”为主题，帮我创作一条小红书图文，并给出可发布的成品')
    await page.locator('button[aria-label="发送"]').first().click()
    await page.waitForTimeout(12000)
    const agent = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ').slice(-700)
    log.push('AGENT=' + agent)
    await page.screenshot({ path: join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04/agent-reply.png') }).catch(() => {})
  } else {
    log.push('AGENT_INPUT_NOT_FOUND')
  }
  for (const line of log) console.log('LINE ' + line)
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
