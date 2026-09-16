#!/usr/bin/env node
/** Worker 09：账号授权深度验证——点击小红书卡后观察真实前端状态，不能再只数按钮。 */
import {
  acceptDisclaimer,
  bodyText,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  shot,
} from './parallel-lib.mjs'

const spec = { index: 9, port: 31412 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('AUTH-DEPTH')
let app
let pass = true

try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)

  await page.locator('[data-testid="sidebar-account-entry"]').first().click({ timeout: 8000 })
  await page.waitForTimeout(1600)
  const connect = page.locator('[data-testid="cm-sidebar-connect-btn"]').first()
  await connect.click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(1400)

  const xhsCard = page.locator('[data-testid="cm-connect-platform-card"]').filter({ hasText: '小红书' }).first()
  if (await xhsCard.count() === 0) {
    reporter.fail('AUTH-CLICK', '未找到小红书授权卡片', await shot(page, worker.workerDir, 'AUTH-no-card'))
    pass = false
    throw new Error('no xhs card')
  }
  await xhsCard.click({ timeout: 10000 })
  const before = await bodyText(page)
  await page.waitForTimeout(8000)
  const refreshQr = page.getByRole('button', { name: /刷新二维码/ }).first()
  if (await refreshQr.count() > 0 && await refreshQr.isVisible().catch(() => false)) {
    await refreshQr.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(12000)
  }
  const after = await bodyText(page)
  const pageHasAuthLoading = await page.locator('[data-testid="cm-auth-loading"]').count() > 0
  const pageHasQr = await page.locator('[data-testid="cm-auth-douyin-miniapp-qr"], [data-testid="cm-auth-desktop-login"], img[src*="data:image"]').count() > 0
  const qrInfo = await page.evaluate(() => Array.from(document.images)
    .filter((img) => (img.src || '').includes('data:image'))
    .map((img) => ({ src: img.src.slice(0, 60), w: img.naturalWidth, h: img.naturalHeight })))
  console.log('AUTH_QR_INFO=' + JSON.stringify(qrInfo))
  const noPythonMissing = !after.includes('Python 环境缺失') && !after.includes('平台登录引擎未安装')
  const stateChanged = before !== after || pageHasAuthLoading || pageHasQr
  reporter[noPythonMissing && stateChanged ? 'pass' : 'fail']('AUTH-EFFECT',
    `loading=${pageHasAuthLoading} qr=${pageHasQr} changed=${stateChanged} noPython=${noPythonMissing} qrInfo=${JSON.stringify(qrInfo)} tail=${after.slice(-180)}`,
    await shot(page, worker.workerDir, 'AUTH-effect'))
  if (!noPythonMissing || !stateChanged) pass = false
  reporter.pass('AUTH-DIAG', '认证流程已在页面发起；扫码完成需要用户手机操作', await shot(page, worker.workerDir, 'AUTH-diagnostic'))
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('WORKER', String(error).slice(0, 1200), await shot(errorPage, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}

const report = await reporter.write(worker.workerDir, pass)
console.log(`WORKER_AUTH_DEPTH ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length}`)
process.exit(report.pass ? 0 : 1)
