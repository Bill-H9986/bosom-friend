#!/usr/bin/env node
/**
 * 真实已登录账号的前端同步验证。
 * 只复制 accounts.json 到隔离 home（不输出/不公开 cookie），页面操作后观察账号状态变化。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acceptDisclaimer,
  bodyText,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  shot,
} from './parallel-lib.mjs'

const spec = { index: 95, port: 31413 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('REAL-ACCOUNT-SYNC')
let app
let home = worker.home
let pass = true

try {
  const realHome = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend')
  const sourceAccounts = join(realHome, 'accounts.json')
  if (!existsSync(sourceAccounts)) {
    reporter.fail('SEED', '未找到真实 accounts.json')
    pass = false
    throw new Error('no accounts.json')
  }
  home = mkdtempSync(join(tmpdir(), 'bf-real-account-'))
  mkdirSync(join(home, 'bosom-friend'), { recursive: true })
  copyFileSync(sourceAccounts, join(home, 'bosom-friend', 'accounts.json'))

  app = await launchWorker(spec, { ...worker, home })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)

  await page.locator('[data-testid="sidebar-account-entry"]').first().click({ timeout: 8000 })
  await page.waitForTimeout(1800)
  const before = await bodyText(page)
  const accountCards = await page.locator('[data-testid="cm-channel-item"]').count()
  reporter[accountCards >= 2 ? 'pass' : 'fail']('ACCOUNT-READ', `账号卡=${accountCards}`, await shot(page, worker.workerDir, 'ACCOUNT-read'))
  if (accountCards < 2) pass = false

  const refresh = page.locator('[data-testid="cm-refresh-all-fans-btn"], [data-testid="cm-channel-refresh-fans-btn"]').first()
  const refreshVisible = await refresh.count() > 0 && await refresh.isVisible().catch(() => false)
  reporter[refreshVisible ? 'pass' : 'fail']('ACCOUNT-REFRESH-BTN', `refreshVisible=${refreshVisible}`, await shot(page, worker.workerDir, 'ACCOUNT-refresh-btn'))
  if (!refreshVisible) pass = false
  if (refreshVisible) {
    await refresh.click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(12000)
  }
  const after = await bodyText(page)
  const changed = before !== after
  reporter[changed ? 'pass' : 'fail']('ACCOUNT-SYNC-EFFECT', `页面状态变化=${changed}`, await shot(page, worker.workerDir, 'ACCOUNT-sync-effect'))
  if (!changed) pass = false
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('WORKER', String(error).slice(0, 1200), await shot(errorPage, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
  try { if (home !== worker.home) rmSync(home, { recursive: true, force: true }) } catch { /* cleanup best effort */ }
}

const report = await reporter.write(worker.workerDir, pass)
console.log(`WORKER_REAL_ACCOUNT_SYNC ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length}`)
process.exit(report.pass ? 0 : 1)
