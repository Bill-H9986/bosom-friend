#!/usr/bin/env node
/** 打包版 0.2.31 认证前置：请求平台登录应不再返回“Python 环境缺失”。 */
import {
  acceptDisclaimer,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  shot,
} from './parallel-lib.mjs'

const spec = { index: 96, port: 31410 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('AUTH-ENV')
let app
let pass = true
try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)
  const response = await fetch(`http://127.0.0.1:${spec.port}/bosom-friend/api/v2/channels/accounts/auth/xhs?groupId=grp-default`)
  const body = await response.json().catch(() => ({}))
  const ok = body?.code === 0 && typeof body?.data?.url === 'string' && body.data.url.includes('/bosom-friend/api/platform-login/qr/')
  console.log('AUTH_ENV=' + JSON.stringify({ status: response.status, code: body?.code, hasUrl: typeof body?.data?.url === 'string', message: body?.message ?? '' }))
  reporter[ok ? 'pass' : 'fail']('AUTH-ENV', `code=${body?.code ?? '?'} url=${typeof body?.data?.url === 'string' ? 'yes' : 'no'} message=${body?.message ?? ''}`, await shot(page, worker.workerDir, 'AUTH-ENV'))
  if (!ok) pass = false
} catch (error) {
  reporter.fail('WORKER', String(error).slice(0, 1200), await shot(app ? app.windows()[0] : null, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}
const report = await reporter.write(worker.workerDir, pass)
console.log(`AUTH_ENV_PROBE ${report.pass ? 'PASS' : 'FAIL'}`)
process.exit(report.pass ? 0 : 1)
