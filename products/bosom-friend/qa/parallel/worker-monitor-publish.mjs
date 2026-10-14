#!/usr/bin/env node
/** Worker 03：全局监控 / 接待入口 / 账号管理 / 发布弹窗（页面操作，不触达后端）。 */
import {
  acceptDisclaimer,
  bodyText,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  repoRoot,
  shot,
} from './parallel-lib.mjs'
import { join } from 'node:path'

const spec = { index: 3, port: 31403 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('D/G/E')
let app
let pass = true

async function clickNav(page, label) {
  const nav = page.locator('[data-testid^="sidebar-nav-item-"]').filter({ hasText: label }).first()
  if (await nav.count() > 0) await nav.click({ timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(1800)
}

try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)

  // G 全局监控：页面可见、立即轮询、立即处理待办
  await clickNav(page, '全局监控')
  const monitorText = await bodyText(page)
  const monitorOk = monitorText.includes('接待引擎') || monitorText.includes('全局监控') || monitorText.includes('立即轮询')
  reporter[monitorOk ? 'pass' : 'fail']('G1', '全局监控页面可见', await shot(page, worker.workerDir, 'G1-monitor'))
  if (!monitorOk) pass = false

  const pollNow = page.getByRole('button', { name: /立即轮询/ }).first()
  if (await pollNow.count() > 0 && await pollNow.isVisible().catch(() => false)) {
    await pollNow.click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(2500)
    const afterPoll = await bodyText(page)
    reporter.pass('G6', `立即轮询后页面文本=${afterPoll.length}`, await shot(page, worker.workerDir, 'G6-poll-now'))
  } else {
    reporter.fail('G6', '未找到「立即轮询」按钮', await shot(page, worker.workerDir, 'G6-no-poll'))
    pass = false
  }

  const processNow = page.getByRole('button', { name: /立即处理待办/ }).first()
  if (await processNow.count() > 0 && await processNow.isVisible().catch(() => false)) {
    await processNow.click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(3000)
    const processText = await bodyText(page)
    const resultVisible = /当前没有待处理|已自动处理|自动处理未成功|自动处理待办失败/.test(processText)
    reporter[resultVisible ? 'pass' : 'fail']('G4/G5', '立即处理待办有可见结果', await shot(page, worker.workerDir, 'G5-process-now'))
    if (!resultVisible) pass = false
  } else {
    reporter.fail('G4/G5', '未找到「立即处理待办」按钮', await shot(page, worker.workerDir, 'G5-no-process'))
    pass = false
  }

  // E 账号管理
  await page.locator('[data-testid="sidebar-account-entry"]').first().click({ timeout: 8000 })
  await page.waitForTimeout(1800)
  const manager = page.locator('[data-testid="channel-manager-dialog"]').first()
  const managerVisible = await manager.count() > 0 && await manager.isVisible().catch(() => false)
  reporter[managerVisible ? 'pass' : 'fail']('E1', '频道管理打开', await shot(page, worker.workerDir, 'E1-manager'))
  if (!managerVisible) pass = false
  const connect = page.locator('[data-testid="cm-sidebar-connect-btn"]').first()
  if (await connect.count() > 0 && await connect.isVisible().catch(() => false)) {
    await connect.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const listText = await bodyText(page)
    const cards = await page.locator('[data-testid="cm-connect-platform-card"]').count()
    const hasDouyin = listText.includes('抖音')
    const hasXhs = listText.includes('小红书')
    reporter[cards >= 1 && hasDouyin ? 'pass' : 'fail']('E2', `连接平台卡=${cards} 抖音=${hasDouyin} 小红书=${hasXhs}`, await shot(page, worker.workerDir, 'E2-connect-cards'))
    if (cards < 1 || !hasDouyin) pass = false
    if (!hasXhs) {
      reporter.fail('E2-XHS', '连接列表中未见「小红书」卡片；当前运行时平台能力清单可能未开放小红书', await shot(page, worker.workerDir, 'E2-xhs-missing'))
      pass = false
    }
    await page.locator('[data-testid="cm-connect-back-btn"]').first().click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(500)
  } else {
    reporter.fail('E2', '未找到连接平台入口', await shot(page, worker.workerDir, 'E2-no-connect'))
    pass = false
  }
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)

  // D 发布弹窗：通过“草稿箱”手动创建一张草稿，然后点发布
  await clickNav(page, '内容创作')
  await page.locator('[role="tab"]').filter({ hasText: /^草稿/ }).first().click().catch(() => {})
  await page.waitForTimeout(1500)
  const manual = page.locator('[data-testid="draftbox-manual-create-card"]').first()
  if (await manual.count() > 0 && await manual.isVisible().catch(() => false)) {
    await manual.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const modal = page.locator('[data-testid="draftbox-create-material-modal"]').first()
    const modalVisible = await modal.count() > 0 && await modal.isVisible().catch(() => false)
    if (modalVisible) {
      const title = page.locator('[data-testid="draftbox-material-title-input"]').first()
      if (await title.count() > 0) await title.fill('并行测试-发布弹窗草稿')
      const desc = page.locator('#mention-input-editor').first()
      if (await desc.count() > 0) {
        await desc.click({ timeout: 5000 }).catch(() => {})
        await page.keyboard.type('这是一个由真实页面创建的测试草稿，用于验证发布弹窗链路。')
      }
      const fileInput = page.locator('[data-testid="publish-file-input"]').first()
      const fallbackFileInput = page.locator('input[type="file"]').first()
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(join(repoRoot, 'products', 'bosom-friend', 'desktop', 'build', 'icon.png')).catch(() => {})
        await page.waitForTimeout(1800)
      } else if (await fallbackFileInput.count() > 0) {
        await fallbackFileInput.setInputFiles(join(repoRoot, 'products', 'bosom-friend', 'desktop', 'build', 'icon.png')).catch(() => {})
        await page.waitForTimeout(1800)
      }
      const platform = page.getByText('抖音', { exact: true }).first()
      if (await platform.count() > 0) await platform.click({ timeout: 5000 }).catch(() => {})
      const save = page.locator('[data-testid="draftbox-material-save-btn"]').first()
      const saveEnabled = await save.isEnabled().catch(() => false)
      if (saveEnabled) {
        await save.click({ timeout: 10000 }).catch(() => {})
        await page.waitForTimeout(3500)
        const card = page.locator('[data-testid="draftbox-draft-card"]').first()
        if (await card.count() > 0 && await card.isVisible().catch(() => false)) {
          await card.click({ timeout: 8000 }).catch(() => {})
          await page.waitForTimeout(1200)
        }
        const publishBtn = page.locator('[data-testid="draftbox-detail-publish-btn"]').first()
        const publishVisible = await publishBtn.count() > 0 && await publishBtn.isVisible().catch(() => false)
        if (publishVisible) {
          await publishBtn.click({ timeout: 8000 }).catch(() => {})
          await page.waitForTimeout(1800)
          const dialog = page.locator('[data-testid="publish-dialog-container"]').first()
          const publishDialog = await dialog.count() > 0 && await dialog.isVisible().catch(() => false)
          reporter[publishDialog ? 'pass' : 'fail']('D1', '发布弹窗从草稿详情打开', await shot(page, worker.workerDir, 'D1-publish-dialog'))
          if (!publishDialog) pass = false
        } else {
          reporter.fail('D1', '草稿保存后未打开详情/发布按钮', await shot(page, worker.workerDir, 'D1-no-publish'))
          pass = false
        }
      } else {
        reporter.fail('D1', '创建草稿保存按钮不可用', await shot(page, worker.workerDir, 'D1-save-disabled'))
        pass = false
      }
    } else {
      reporter.fail('D1', '未打开创建草稿弹窗', await shot(page, worker.workerDir, 'D1-no-modal'))
      pass = false
    }
  } else {
    reporter.fail('D1', '未找到手动创建草稿入口', await shot(page, worker.workerDir, 'D1-no-manual'))
    pass = false
  }
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('WORKER', String(error).slice(0, 1200), await shot(errorPage, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}

const report = await reporter.write(worker.workerDir, pass)
console.log(`WORKER_MONITOR_PUBLISH ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length} pageErrors=${report.pageErrors.length}`)
process.exit(report.pass ? 0 : 1)
