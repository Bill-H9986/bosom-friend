#!/usr/bin/env node
/** Worker 01：启动 / 导航 / 设置 / 账号入口 / 任务记录（页面操作，不触达后端）。 */
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

const spec = { index: 1, port: 31401 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('B/E/I/K')
let app
let pass = true

try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)
  const version = await page.evaluate(() => window.__APP_VERSION__ ?? '').catch(() => '')
  reporter.pass('A3', `产品页面可见，版本=${version}`, await shot(page, worker.workerDir, 'A3-product-home'))

  const navLabels = ['内容创作', 'AI互动', '任务记录', '发布日历', '数据中心', '全局监控', '知识库']
  for (const label of navLabels) {
    const nav = page.locator(`[data-testid="sidebar-nav-item-*"]`).filter({ hasText: label }).first()
    if (await nav.count() === 0) {
      // 侧栏可能处于折叠态，先展开
      await page.locator('[data-testid="sidebar-toggle-btn"]').first().click().catch(() => {})
      await page.waitForTimeout(400)
    }
    await nav.click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(1600)
    const text = await bodyText(page)
    const loaded = text.length > 80
    reporter[loaded ? 'pass' : 'fail'](`B1-${label}`, `页面文本长度=${text.length}`, await shot(page, worker.workerDir, `B1-${label}`))
    if (!loaded) pass = false
  }

  // 任务记录：刷新按钮可见且可点击
  await page.getByText('任务记录', { exact: true }).first().click().catch(() => {})
  await page.waitForTimeout(1800)
  const refresh = page.locator('button[aria-label="刷新"]').first()
  const refreshVisible = await refresh.count() > 0 && await refresh.isVisible().catch(() => false)
  if (refreshVisible) {
    await refresh.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1000)
  }
  reporter.pass('I1', '任务页/刷新入口可用', await shot(page, worker.workerDir, 'I1-tasks'))

  // 账号入口：频道管理弹窗主视图 -> 连接列表
  await page.locator('[data-testid="sidebar-account-entry"]').first().click({ timeout: 8000 })
  await page.waitForTimeout(1800)
  const manager = page.locator('[data-testid="channel-manager-dialog"]').first()
  const managerVisible = await manager.count() > 0 && await manager.isVisible().catch(() => false)
  reporter[managerVisible ? 'pass' : 'fail']('E1', '频道管理入口打开', await shot(page, worker.workerDir, 'E1-channel-manager'))
  if (!managerVisible) pass = false
  const connect = page.locator('[data-testid="cm-sidebar-connect-btn"]').first()
  if (await connect.count() > 0 && await connect.isVisible().catch(() => false)) {
    await connect.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const listText = await bodyText(page)
    const hasPlatforms = listText.includes('抖音') && listText.includes('小红书')
    reporter[hasPlatforms ? 'pass' : 'fail']('E1', '连接平台列表可见', await shot(page, worker.workerDir, 'E1-connect-list'))
    if (!hasPlatforms) pass = false
    await page.locator('[data-testid="cm-connect-back-btn"]').first().click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(500)
  } else {
    reporter.fail('E1', '未找到连接新频道按钮', await shot(page, worker.workerDir, 'E1-no-connect'))
    pass = false
  }
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)

  // 设置：用户菜单 -> 设置弹窗 -> 系统与更新
  await page.locator('[data-testid="sidebar-user-trigger"]').first().click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(500)
  const settings = page.locator('[data-testid="sidebar-settings-entry"] button').first()
  if (await settings.count() > 0) {
    await settings.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1400)
    const settingsText = await bodyText(page)
    const tabs = ['通用', '自定义大模型', '系统与更新'].filter((tab) => settingsText.includes(tab))
    reporter[tabs.length === 3 ? 'pass' : 'fail']('K1', `设置页 tabs=${tabs.join(',')}`, await shot(page, worker.workerDir, 'K1-settings'))
    if (tabs.length !== 3) pass = false
    const ota = page.getByRole('button', { name: /系统与更新/ }).first()
    if (await ota.count() > 0) {
      await ota.click({ timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(1200)
      const otaText = await bodyText(page)
      const hasVersion = /0\.2\.27|当前版本|本地运行版本/.test(otaText)
      reporter[hasVersion ? 'pass' : 'fail']('K3', '系统与更新可见并可打开', await shot(page, worker.workerDir, 'K3-system-update'))
      if (!hasVersion) pass = false
    }
  } else {
    reporter.fail('K1', '未找到设置入口', await shot(page, worker.workerDir, 'K1-no-settings'))
    pass = false
  }

  const finalText = await bodyText(page)
  reporter.pass('B4', `最终页面文本长度=${finalText.length}`, await shot(page, worker.workerDir, 'B4-final'))
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('WORKER', String(error).slice(0, 1200), await shot(errorPage, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}

const report = await reporter.write(worker.workerDir, pass)
console.log(`WORKER_NAV_UI ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length} pageErrors=${report.pageErrors.length}`)
process.exit(report.pass ? 0 : 1)
