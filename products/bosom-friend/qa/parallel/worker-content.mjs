#!/usr/bin/env node
/** Worker 04：内容创作真实前端矩阵（图片/视频；只通过页面操作，不直接调用后端）。 */
import {
  acceptDisclaimer,
  bodyText,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  shot,
} from './parallel-lib.mjs'

const spec = { index: 4, port: 31404 }
const worker = prepareWorker(spec, { installRuntime: true, seedLlm: true })
const reporter = makeReporter('C')
let app
let pass = true
const topic = '关于人社局无人机装调检修工程师就业免费培训'
const created = []

async function clickText(page, text, exact = true) {
  const loc = exact ? page.getByText(text, { exact: true }).last() : page.getByText(text).last()
  if (await loc.count() > 0) await loc.click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(500)
}

function safeName(value) {
  return value.replace(/[\\/:*?"<>|]/g, '-')
}

async function closeDialogs(page) {
  const close = page.locator('[role="dialog"] button[aria-label="Close"], [role="dialog"] button[aria-label="关闭"]').last()
  if (await close.count() > 0 && await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 5000 }).catch(() => {})
  } else {
    await page.keyboard.press('Escape').catch(() => {})
  }
  await page.waitForTimeout(600)
}

async function setPrompt(page) {
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(800)
  const input = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  if (await input.count() === 0) throw new Error('未找到提示词编辑器')
  await input.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(topic)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(800)
}

async function setMode(page, mode) {
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await clickText(page, mode)
  await page.waitForTimeout(700)
}

async function setRatio(page, ratio) {
  await page.locator('[data-testid="draftbox-ai-ratio"]').first().click()
  await page.waitForTimeout(500)
  await clickText(page, ratio)
  await page.waitForTimeout(700)
}

async function setResolution(page, resolution) {
  await page.locator('[data-testid="draftbox-ai-resolution"]').first().click()
  await page.waitForTimeout(600)
  await clickText(page, resolution)
  await page.waitForTimeout(700)
}

async function setDuration(page, seconds) {
  const label = `${seconds} 秒`
  await page.locator('[data-testid="draftbox-ai-duration"]').first().click()
  await page.waitForTimeout(600)
  await clickText(page, label)
  await page.waitForTimeout(600)
}

async function submitAndWait(page, label, maxMs = 240000, isVideo = false) {
  const submit = page.locator('[data-testid="draftbox-ai-submit-btn"]').first()
  if (await submit.count() === 0) throw new Error('未找到生成提交按钮')
  await submit.click({ timeout: 10000 })
  await page.waitForTimeout(2500)
  await shot(page, worker.workerDir, `${safeName(label)}-submitted`)
  try {
    const started = Date.now()
    let last = ''
    while (Date.now() - started < maxMs) {
      const text = await bodyText(page)
      last = text.slice(-600)
      const cardCount = await page.locator('[data-testid="draftbox-draft-card"]').count().catch(() => 0)
      if (cardCount > 0 && /(生成成功|已生成|生成完成|已完成|草稿)/.test(text) && !/(生成中|进行中)/.test(text)) {
        return { state: 'success', last }
      }
      if (/(已同步保存为草稿|保存为草稿|生成成功|已生成|生成完成|已完成)/.test(text) && !/(生成中|进行中)/.test(text)) {
        return { state: 'success', last }
      }
      if (/(生成失败|失败|模型响应超时|runtime is not running|错误|异常)/.test(text) && !/(进行中|生成中)/.test(text)) {
        return { state: 'failed', last }
      }
      await page.waitForTimeout(isVideo ? 10000 : 5000)
    }
    return { state: 'unfinished', last }
  } finally {
    await closeDialogs(page)
  }
}

try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  page.on('response', async (res) => {
    if (res.request().method() === 'POST' && /ai\/draft-generation\/v2/.test(res.url())) {
      try {
        const body = await res.json().catch(() => ({}))
        const ids = body?.data?.taskIds ?? []
        if (Array.isArray(ids)) created.push(...ids)
      } catch {
        // response evidence is optional; page state remains authoritative
      }
    }
  })
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)
  const kernelBefore = await page.evaluate(() => window.bosomKernel?.getStatus?.() ?? null).catch(() => null)
  console.log('KERNEL_BEFORE=' + JSON.stringify(kernelBefore))
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2400)
  await setPrompt(page)

  // C3：平台选择器
  await page.getByText(/\d+ 个平台/).first().click().catch(() => {})
  await page.waitForTimeout(700)
  const platformText = await bodyText(page)
  reporter[platformText.includes('抖音') && platformText.includes('小红书') ? 'pass' : 'fail']('C3', '平台选择包含抖音/小红书', await shot(page, worker.workerDir, 'C3-platforms'))
  if (!platformText.includes('抖音') || !platformText.includes('小红书')) pass = false
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)

  const imageCases = [
    { ratio: '3:4', resolution: '720p' },
    { ratio: '9:16', resolution: '720p' },
    { ratio: '16:9', resolution: '720p' },
  ]
  await setMode(page, '生成草稿(图文)')
  for (const item of imageCases) {
    await setRatio(page, item.ratio)
    await setResolution(page, item.resolution)
    const label = `IMG-${item.ratio}-${item.resolution}`
    const result = await submitAndWait(page, label, 240000, false)
    const kernelAfter = await page.evaluate(() => window.bosomKernel?.getStatus?.() ?? null).catch(() => null)
    console.log('KERNEL_AFTER=' + JSON.stringify(kernelAfter))
    reporter[result.state === 'success' ? 'pass' : 'fail'](safeName(label), result.state, await shot(page, worker.workerDir, safeName(label)))
    if (result.state !== 'success') {
      pass = false
      break
    }
  }

  if (pass) {
    reporter.pass('C11/C12', `图文生成完成，任务=${created.length}`, await shot(page, worker.workerDir, 'C11-image-done'))
  }

  if (process.env.BF_CONTENT_ONLY_FIRST !== '1') {
    // 视频矩阵：每个比例 5 秒；Agnes 每分钟限制，任务之间等待 65 秒
    const videoCases = [
      { ratio: '3:4', duration: 5 },
      { ratio: '9:16', duration: 5 },
      { ratio: '16:9', duration: 5 },
    ]
    await setMode(page, '生成草稿(视频)')
    for (const item of videoCases) {
      await setRatio(page, item.ratio)
      await setDuration(page, item.duration)
      const label = `VIDEO-${item.ratio}-${item.duration}s`
      const result = await submitAndWait(page, label, 360000, true)
      reporter[result.state === 'success' ? 'pass' : 'fail'](safeName(label), result.state, await shot(page, worker.workerDir, safeName(label)))
      if (result.state !== 'success') {
        pass = false
        break
      }
      // Agnes free tier: only one video per minute
      if (result.state === 'success' && item !== videoCases[videoCases.length - 1]) {
        await page.waitForTimeout(65000)
      }
    }
  }
  if (process.env.BF_CONTENT_ONLY_FIRST !== '1' && pass) {
    reporter.pass('C6', '视频时长 5 秒与比例矩阵完成', await shot(page, worker.workerDir, 'C6-video-done'))
  }
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('WORKER', String(error).slice(0, 1200), await shot(errorPage, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}

const report = await reporter.write(worker.workerDir, pass)
console.log(`WORKER_CONTENT ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length} pageErrors=${report.pageErrors.length}`)
process.exit(report.pass ? 0 : 1)
