#!/usr/bin/env node
/** Worker 08：深度效应测试——每个动作必须证明“页面状态发生了真实变化”。 */
import { join } from 'node:path'
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

const spec = { index: 8, port: 31411 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('DEEP-EFFECTS')
let app
let pass = true
let dataStatsResponse = false

async function waitHash(page, route) {
  await page.waitForFunction((target) => location.hash.includes(target), route, { timeout: 15000 })
}

async function go(page, label, route, marker) {
  const nav = page.locator('[data-testid^="sidebar-nav-item-"]').filter({ hasText: label }).first()
  if (await nav.count() === 0) {
    reporter.fail(`NAV-${label}`, '导航项不存在')
    pass = false
    return
  }
  await nav.click({ timeout: 10000 }).catch(() => {})
  await waitHash(page, route)
  const markerVisible = marker !== '' && await page.locator(marker).first().isVisible({ timeout: 15000 }).then(() => true).catch(() => false)
  return markerVisible
}

async function closeModal(page) {
  const close = page.locator('[role="dialog"] button[aria-label="Close"], [role="dialog"] button[aria-label="关闭"]').last()
  if (await close.count() > 0 && await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 5000 }).catch(() => {})
  } else {
    await page.keyboard.press('Escape').catch(() => {})
  }
  await page.waitForTimeout(600)
}

async function openSettings(page) {
  await page.locator('[data-testid="sidebar-user-trigger"]').first().click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(600)
  await page.locator('[data-testid="sidebar-settings-entry"] button').first().click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(1400)
}

async function createDraft(page) {
  await page.locator('[role="tab"]').filter({ hasText: /^草稿/ }).first().click().catch(() => {})
  await page.waitForTimeout(1200)
  const manual = page.locator('[data-testid="draftbox-manual-create-card"]').first()
  if (await manual.count() === 0) throw new Error('未找到手动创建草稿入口')
  await manual.click({ timeout: 8000 })
  await page.waitForTimeout(1200)
  const title = page.locator('[data-testid="draftbox-material-title-input"]').first()
  await title.fill('深度效应-发布草稿')
  const deselect = page.getByText(/取消全选/).first()
  if (await deselect.count() > 0) await deselect.click({ timeout: 5000 }).catch(() => {})
  const platform = page.locator('button[title="抖音"]').first()
  if (await platform.count() > 0) await platform.click({ timeout: 5000 }).catch(() => {})
  const desc = page.locator('#mention-input-editor').first()
  await desc.click({ timeout: 5000 }).catch(() => {})
  await page.keyboard.type('这是用于验证发布弹窗与前端校验的真实草稿。')
  const file = page.locator('[data-testid="publish-file-input"]').first()
  if (await file.count() > 0) {
    await file.setInputFiles(join(repoRoot, 'products', 'bosom-friend', 'desktop', 'build', 'icon.png')).catch(() => {})
    await page.waitForTimeout(1800)
  }
  const save = page.locator('[data-testid="draftbox-material-save-btn"]').first()
  if (await save.count() === 0) throw new Error('未找到保存按钮')
  await save.click({ timeout: 10000 })
  await page.waitForTimeout(3200)
  const card = page.locator('[data-testid="draftbox-draft-card"]').first()
  if (await card.count() > 0 && await card.isVisible().catch(() => false)) {
    await card.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1000)
  }
  return page.locator('[data-testid="draftbox-detail-publish-btn"]').first()
}

try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  page.on('response', async (res) => {
    if (res.url().includes('/v2/statistics/') || res.url().includes('published-content-summary')) {
      const body = await res.text().catch(() => '')
      if (body.includes('"code":0') || body.includes('"code": 0')) dataStatsResponse = true
    }
  })
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)

  // B：每个导航真实跳转 + 页面特征元素
  const routes = [
    ['内容创作', '#/draft-box', '[data-testid="draftbox-ai-gen-mode"]'],
    ['AI互动', '#/ai-interaction', '[data-testid="xhs-data-note-comment-search-components-search-filters-input-1"]'],
    ['我的任务', '#/tasks-history', 'input[placeholder*="搜索"]'],
    ['发布日历', '#/calendar', '[data-testid="calendar-container"]'],
    ['数据中心', '#/data-statistics', '[data-testid="data-statistics-query"]'],
    ['全局监控', '#/monitor', '[data-testid="reception-auto-result"]'],
    ['知识库', '#/knowledge', 'button:has-text("新建笔记")'],
  ]
  for (const [label, route, marker] of routes) {
    const ok = await go(page, label, route, marker)
    reporter[ok ? 'pass' : 'fail'](`NAV-${label}`, `route=${route} marker=${marker}`, await shot(page, worker.workerDir, `NAV-${label}`))
    if (!ok) pass = false
  }

  // G：监控“效果”验证
  await go(page, '全局监控', '#/monitor', '[data-testid="reception-auto-result"]')
  const monitorBefore = await bodyText(page)
  const poll = page.getByRole('button', { name: /立即轮询/ }).first()
  await poll.click({ timeout: 10000 })
  await page.waitForTimeout(2500)
  const monitorAfter = await bodyText(page)
  const roundsBefore = Number((monitorBefore.match(/已完成轮次\s*(\d+)/)?.[1] ?? '0'))
  const roundsAfter = Number((monitorAfter.match(/已完成轮次\s*(\d+)/)?.[1] ?? '0'))
  const pollEffected = roundsAfter !== roundsBefore || monitorAfter !== monitorBefore
  reporter[pollEffected ? 'pass' : 'fail']('G-EFFECT', `轮次 ${roundsBefore}→${roundsAfter}`, await shot(page, worker.workerDir, 'G-effect'))
  if (!pollEffected) pass = false
  const process = page.getByRole('button', { name: /立即处理待办/ }).first()
  await process.click({ timeout: 10000 })
  await page.waitForTimeout(3000)
  const result = page.locator('[data-testid="reception-auto-result"]').first()
  const resultText = (await result.textContent().catch(() => '')) || ''
  const resultEffected = /当前没有待处理|已自动处理|自动处理未成功|自动处理待办失败/.test(resultText)
  reporter[resultEffected ? 'pass' : 'fail']('G-PROCESS-EFFECT', `result=${resultText.slice(0, 120)}`, await shot(page, worker.workerDir, 'G-process-effect'))
  if (!resultEffected) pass = false

  // F：数据中心查询之后更新时间/响应变化
  await go(page, '数据中心', '#/data-statistics', '[data-testid="data-statistics-query"]')
  const beforeUpdated = await page.locator('[data-testid="data-statistics-updated-at"]').textContent().catch(() => '')
  const query = page.locator('[data-testid="data-statistics-query"]').first()
  await query.click({ timeout: 10000 })
  await page.waitForTimeout(2500)
  const afterUpdated = await page.locator('[data-testid="data-statistics-updated-at"]').textContent().catch(() => '')
  const updateEffected = beforeUpdated !== afterUpdated || (await bodyText(page)).includes('已更新')
  reporter[dataStatsResponse && updateEffected ? 'pass' : 'fail']('F-EFFECT', `request=${dataStatsResponse} updated ${beforeUpdated}→${afterUpdated} state=${updateEffected}`, await shot(page, worker.workerDir, 'F-effect'))
  if (!dataStatsResponse || !updateEffected) pass = false

  // K：主题切换真实改变文档主题
  await openSettings(page)
  const themeBefore = await page.evaluate(() => ({ cls: document.documentElement.className, bg: getComputedStyle(document.body).backgroundColor }))
  await page.getByText('深色', { exact: true }).first().click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(1800)
  const themeAfter = await page.evaluate(() => ({ cls: document.documentElement.className, bg: getComputedStyle(document.body).backgroundColor }))
  const themeEffected = themeBefore.cls !== themeAfter.cls || themeBefore.bg !== themeAfter.bg
  reporter[themeEffected ? 'pass' : 'fail']('K-EFFECT', `cls ${themeBefore.cls}→${themeAfter.cls} bg ${themeBefore.bg}→${themeAfter.bg}`, await shot(page, worker.workerDir, 'K-effect'))
  if (!themeEffected) pass = false
  await closeModal(page)

  // D：发布弹窗 + 无账号真实校验
  await go(page, '内容创作', '#/draft-box', '[data-testid="draftbox-ai-gen-mode"]')
  const publish = await createDraft(page)
  const publishVisible = await publish.count() > 0 && await publish.isVisible().catch(() => false)
  reporter[publishVisible ? 'pass' : 'fail']('D-DRAFT-PUBLISH', '草稿保存后出现发布按钮', await shot(page, worker.workerDir, 'D-draft-publish'))
  if (!publishVisible) pass = false
  if (publishVisible) {
    await publish.click({ timeout: 8000 })
    await page.waitForTimeout(1800)
    const dialog = page.locator('[data-testid="publish-dialog-container"]').first()
    const dialogVisible = await dialog.count() > 0 && await dialog.isVisible().catch(() => false)
    reporter[dialogVisible ? 'pass' : 'fail']('D-DIALOG', '发布弹窗出现', await shot(page, worker.workerDir, 'D-dialog'))
    if (!dialogVisible) pass = false
    const submit = page.locator('[data-testid="publish-submit-btn"]').first()
    if (await submit.count() > 0) {
      await submit.click({ timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(1800)
    }
    const body = await bodyText(page)
    const validated = /还没有添加账号|添加频道|请选择至少一个发布账号|登录失效|账号|缺少媒体|缺少标题/.test(body)
    reporter[validated ? 'pass' : 'fail']('D-VALIDATION', '无账号/无发布条件时如实校验', await shot(page, worker.workerDir, 'D-validation'))
    if (!validated) pass = false
  }
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('WORKER', String(error).slice(0, 1400), await shot(errorPage, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}

const report = await reporter.write(worker.workerDir, pass)
console.log(`WORKER_DEEP_EFFECTS ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length}`)
process.exit(report.pass ? 0 : 1)
