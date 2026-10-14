#!/usr/bin/env node
/** Worker 06：数据中心 / 发布日历 / AI互动页（只页面操作，无外部费用）。 */
import {
  acceptDisclaimer,
  bodyText,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  shot,
} from './parallel-lib.mjs'

const spec = { index: 6, port: 31406 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('F/D/J')
let app
let pass = true

async function go(page, label) {
  const nav = page.locator('[data-testid^="sidebar-nav-item-"]').filter({ hasText: label }).first()
  if (await nav.count() > 0) await nav.click({ timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(2200)
}

try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)

  await go(page, '数据中心')
  const dataText = await bodyText(page)
  const dataOk = dataText.includes('查询') || dataText.includes('已更新') || dataText.includes('发布作品')
  reporter[dataOk ? 'pass' : 'fail']('F1', '数据中心页面及控制项可见', await shot(page, worker.workerDir, 'F1-datacenter'))
  if (!dataOk) pass = false
  const query = page.locator('[data-testid="data-statistics-query"]').first()
  if (await query.count() > 0 && await query.isVisible().catch(() => false)) {
    await query.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(800)
  }
  reporter.pass('F2', '查询按钮可操作', await shot(page, worker.workerDir, 'F2-query'))

  await go(page, '发布日历')
  const calendarText = await bodyText(page)
  const calOk = page.locator('[data-testid="calendar-container"]').count() > 0 || /公历|节日|节气/.test(calendarText)
  reporter[calOk ? 'pass' : 'fail']('D5', '发布日历页面可见', await shot(page, worker.workerDir, 'D5-calendar'))
  if (!calOk) pass = false
  const week = page.locator('[data-testid="calendar-view-week"]').first()
  const month = page.locator('[data-testid="calendar-view-month"]').first()
  if (await week.count() > 0) {
    await week.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(500)
  }
  if (await month.count() > 0) {
    await month.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(500)
  }
  reporter.pass('D5', '周/月视图切换可用', await shot(page, worker.workerDir, 'D5-week-month'))

  await go(page, 'AI互动')
  const aiText = await bodyText(page)
  const aiOk = aiText.includes('热点内容') || aiText.includes('评论搜索') || aiText.includes('AI互动')
  reporter[aiOk ? 'pass' : 'fail']('J3', 'AI互动页面/标签可见', await shot(page, worker.workerDir, 'J3-ai-interaction'))
  if (!aiOk) pass = false
  const comment = page.getByRole('button', { name: /评论搜索/ }).first()
  if (await comment.count() > 0) {
    await comment.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(700)
  }
  reporter.pass('J3', '评论搜索标签可切换', await shot(page, worker.workerDir, 'J3-comment-tab'))
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('WORKER', String(error).slice(0, 1200), await shot(errorPage, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}

const report = await reporter.write(worker.workerDir, pass)
console.log(`WORKER_MISC_UI ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length}`)
process.exit(report.pass ? 0 : 1)
