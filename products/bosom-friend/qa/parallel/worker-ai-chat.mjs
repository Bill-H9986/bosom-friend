#!/usr/bin/env node
/** Worker 05：右侧 AI 助手真实对话（页面操作；本 worker 必须在视频/图片生成结束后单独运行）。 */
import {
  acceptDisclaimer,
  bodyText,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  shot,
} from './parallel-lib.mjs'

const spec = { index: 5, port: 31405 }
const worker = prepareWorker(spec, { installRuntime: true, seedLlm: true })
const reporter = makeReporter('J')
let app
let pass = true

try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)
  const sidebar = page.locator('[data-testid="ai-assistant-sidebar"]').first()
  if (await sidebar.count() === 0) {
    reporter.fail('J1', '右侧 AI 助手面板不存在', await shot(page, worker.workerDir, 'J1-no-sidebar'))
    pass = false
    throw new Error('no assistant sidebar')
  }
  if (!(await sidebar.isVisible().catch(() => false))) {
    await page.locator('[data-testid="ai-assistant-expand-btn"]').first().click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(800)
  }
  reporter.pass('J1', '右侧 AI 助手面板可见', await shot(page, worker.workerDir, 'J1-sidebar'))
  const input = page.locator('[data-testid="ai-assistant-sidebar"] textarea[placeholder*="输入你的需求"]').first()
  if (await input.count() === 0) {
    reporter.fail('J1', '未找到 AI 输入框', await shot(page, worker.workerDir, 'J1-no-input'))
    pass = false
    throw new Error('no assistant input')
  }
  const prompt = '请用一句话介绍无人机装调检修工程师免费培训'
  await input.fill(prompt)
  const send = page.locator('[data-testid="ai-assistant-sidebar"] button[aria-label="发送"]').last()
  if (await send.count() === 0) {
    reporter.fail('J1', '未找到发送按钮', await shot(page, worker.workerDir, 'J1-no-send'))
    pass = false
    throw new Error('no send button')
  }
  await send.click({ timeout: 10000 })
  reporter.pass('J1', '已从页面发送真实问题', await shot(page, worker.workerDir, 'J1-sent'))

  let last = ''
  for (let i = 0; i < 18; i += 1) {
    await page.waitForTimeout(5000)
    const text = await bodyText(page)
    last = text.slice(-1200)
    if (/未接入任何大模型|大模型调用失败|模型响应超时/.test(text)) {
      reporter.fail('J2', 'AI 如实呈现异常/未配置状态', await shot(page, worker.workerDir, 'J2-error'))
      pass = false
      break
    }
    if (/无人机|免费培训|装调检修|人社局/.test(text) && !/有什么我可以帮你/.test(text)) {
      reporter.pass('J2', 'AI 助手返回真实回复', await shot(page, worker.workerDir, 'J2-reply'))
      pass = true
      break
    }
  }
  if (!last) {
    reporter.fail('J2', '未观察到 AI 回复', await shot(page, worker.workerDir, 'J2-no-reply'))
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
console.log(`WORKER_AI_CHAT ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length} pageErrors=${report.pageErrors.length}`)
process.exit(report.pass ? 0 : 1)
