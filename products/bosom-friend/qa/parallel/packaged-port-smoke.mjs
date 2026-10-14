#!/usr/bin/env node
/** 打包版 0.2.27 端口/用户目录隔离冒烟：真实窗口加载后验证版本与 URL。 */
import {
  acceptDisclaimer,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  shot,
} from './parallel-lib.mjs'

const spec = { index: 99, port: 31405 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('PACKAGED-SMOKE')
let app
let pass = true
try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await acceptDisclaimer(page)
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  const url = page.url()
  const version = await page.evaluate(() => window.__APP_VERSION__ ?? '').catch(() => '')
  const versionOk = /0\.2\.31/.test(version)
  const portOk = url.includes(`127.0.0.1:${spec.port}/bosom-friend/`)
  reporter.pass('PACKAGED-PORT', `version=${version} url=${url}`, await shot(page, worker.workerDir, 'PACKAGED-PORT'))
  if (!versionOk || !portOk) {
    reporter.fail('PACKAGED-PORT', `version=${version} url=${url}`, await shot(page, worker.workerDir, 'PACKAGED-PORT-FAIL'))
    pass = false
  }
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('PACKAGED-PORT', String(error).slice(0, 1200), await shot(errorPage, worker.workerDir, 'PACKAGED-PORT-ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}
const report = await reporter.write(worker.workerDir, pass)
console.log(`PACKAGED_PORT_SMOKE ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length}`)
process.exit(report.pass ? 0 : 1)
