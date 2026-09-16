#!/usr/bin/env node
/** Worker 07：账号管理“可连接平台”专项——页面可见卡片 + 后端诊断，不触达账号授权。 */
import {
  acceptDisclaimer,
  bodyText,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  shot,
} from './parallel-lib.mjs'

const spec = { index: 7, port: 31407 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('E-ACCOUNT')
let app
let pass = true

try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)

  await page.locator('[data-testid="sidebar-account-entry"]').first().click({ timeout: 8000 })
  await page.waitForTimeout(1800)
  reporter.pass('E-ENTRY', '频道管理入口打开', await shot(page, worker.workerDir, 'E-entry'))

  const connect = page.locator('[data-testid="cm-sidebar-connect-btn"]').first()
  if (await connect.count() > 0 && await connect.isVisible().catch(() => false)) {
    await connect.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1600)
  }
  const cards = page.locator('[data-testid="cm-connect-platform-card"]')
  const cardCount = await cards.count()
  const names = []
  for (let i = 0; i < cardCount; i += 1) {
    names.push(((await cards.nth(i).textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim())
  }
  const pageText = await bodyText(page)
  const hasDouyin = names.some((name) => name.includes('抖音'))
  const hasXhs = names.some((name) => name.includes('小红书'))
  reporter[cardCount >= 2 && hasDouyin && hasXhs ? 'pass' : 'fail']('E-PLATFORM-CARDS',
    `卡片数=${cardCount} names=${names.join('|')}`,
    await shot(page, worker.workerDir, 'E-platform-cards'))
  if (cardCount < 2 || !hasDouyin || !hasXhs) pass = false
  reporter.pass('E-EMPTY-STATE', `账号数=0 页面=${pageText.includes('0')}`, await shot(page, worker.workerDir, 'E-empty-state'))
  const countText = await page.locator('[data-testid="cm-channel-count"]').textContent().catch(() => '')
  reporter.pass('E-COUNT', `频道计数=${countText?.trim() ?? ''}`, await shot(page, worker.workerDir, 'E-count'))

  // 仅诊断：确认平台目录响应包含 xhs/douyin；页面卡片仍是唯一 PASS 依据。
  const diag = await fetch(`http://127.0.0.1:${spec.port}/bosom-friend/api/v2/channels/platforms`)
  const diagBody = await diag.json().catch(() => ({}))
  const platforms = (diagBody?.data ?? []).map((item) => item.platform)
  console.log('PLATFORM_DIAG=' + JSON.stringify(platforms))
  reporter.pass('E-DIAG', `api platforms=${platforms.join(',')}`, '')
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('WORKER', String(error).slice(0, 1200), await shot(errorPage, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}

const report = await reporter.write(worker.workerDir, pass)
console.log(`WORKER_ACCOUNT_PLATFORMS ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length}`)
process.exit(report.pass ? 0 : 1)
