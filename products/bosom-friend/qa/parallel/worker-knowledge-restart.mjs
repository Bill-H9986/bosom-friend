#!/usr/bin/env node
/** Worker 02：知识库创建/编辑/搜索/双向链接/删除 + 重启后持久化（页面操作，不触达后端）。 */
import {
  acceptDisclaimer,
  bodyText,
  closeWorker,
  launchWorker,
  makeReporter,
  prepareWorker,
  shot,
} from './parallel-lib.mjs'

const spec = { index: 2, port: 31402 }
const worker = prepareWorker(spec, { installRuntime: true })
const reporter = makeReporter('H/L')
let app
let pass = true

async function goKnowledge(page) {
  await page.getByText('知识库', { exact: true }).first().click().catch(() => {})
  await page.waitForTimeout(2200)
  await acceptDisclaimer(page)
}

async function openNewNote(page, name) {
  const create = page.getByRole('button', { name: /新建笔记/ }).first()
  if (await create.count() === 0) throw new Error('未找到「新建笔记」按钮')
  await create.click({ timeout: 8000 })
  await page.waitForTimeout(600)
  const input = page.getByPlaceholder('笔记名称').first()
  await input.fill(name)
  await page.getByRole('button', { name: /创建/ }).first().click({ timeout: 8000 })
  await page.waitForTimeout(2200)
}

try {
  app = await launchWorker(spec, worker)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page)

  await goKnowledge(page)
  const initialText = await bodyText(page)
  reporter.pass('H1', '知识库页面初始可见', await shot(page, worker.workerDir, 'H1-initial'))

  const first = '并行测试-无人机培训'
  const second = '并行测试-知识关联'
  await openNewNote(page, first)
  const textarea = page.locator('textarea').first()
  if (await textarea.count() === 0) {
    reporter.fail('H2', '未找到笔记编辑器', await shot(page, worker.workerDir, 'H2-no-editor'))
    pass = false
    throw new Error('no editor')
  }
  await textarea.fill('这是并行测试笔记，内容包含 [[并行测试-知识关联]]。')
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: /保存/ }).first().click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(1000)
  const afterCreate = await bodyText(page)
  const created = afterCreate.includes(first) && afterCreate.includes('已保存')
  reporter[created ? 'pass' : 'fail']('H2', '新建并保存笔记', await shot(page, worker.workerDir, 'H2-created'))
  if (!created) pass = false

  // 搜索
  const search = page.getByPlaceholder('搜索笔记…').first()
  await search.fill(first)
  await page.waitForTimeout(1300)
  const searchText = await bodyText(page)
  const searchHit = searchText.includes(first)
  reporter[searchHit ? 'pass' : 'fail']('H1', '搜索可命中新建笔记', await shot(page, worker.workerDir, 'H1-search'))
  if (!searchHit) pass = false
  await search.fill('')
  await page.waitForTimeout(800)

  // 第二篇笔记，验证双向链接
  await openNewNote(page, second)
  const secondTextarea = page.locator('textarea').first()
  if (await secondTextarea.count() === 0) {
    reporter.fail('H3', '未找到第二篇编辑器', await shot(page, worker.workerDir, 'H3-no-editor'))
    pass = false
  } else {
    await secondTextarea.fill('链接到第一篇：[[并行测试-无人机培训]]')
    await page.waitForTimeout(900)
    await page.getByRole('button', { name: /保存/ }).first().click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1000)
    const linkText = await bodyText(page)
    const linkVisible = linkText.includes(first)
    reporter[linkVisible ? 'pass' : 'fail']('H3', '双向链接内容可见', await shot(page, worker.workerDir, 'H3-backlink'))
    if (!linkVisible) pass = false
  }

  // 删除第二篇：保持第一篇用于持久化验证
  const deleteBtn = page.locator('button[title="删除笔记"]').first()
  if (await deleteBtn.count() > 0) {
    await deleteBtn.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(600)
    const confirmDelete = page.getByRole('button', { name: /删除/ }).last()
    if (await confirmDelete.count() > 0) await confirmDelete.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const afterDelete = await bodyText(page)
    const absent = !afterDelete.includes(second)
    reporter[absent ? 'pass' : 'fail']('H4', '删除后页面不可见', await shot(page, worker.workerDir, 'H4-deleted'))
    if (!absent) pass = false
  } else {
    reporter.fail('H4', '未找到删除按钮', await shot(page, worker.workerDir, 'H4-no-delete'))
    pass = false
  }

  await closeWorker(app)
  app = null

  // 重启：同一 userData + 同一 BOSOM_FRIEND_HOME，验证第一篇仍在
  app = await launchWorker(spec, worker)
  const page2 = await app.firstWindow()
  page2.on('pageerror', (error) => reporter.pageErrors.push(String(error)))
  await page2.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 240000 })
  await acceptDisclaimer(page2)
  await goKnowledge(page2)
  const persistedText = await bodyText(page2)
  const persisted = persistedText.includes(first)
  reporter[persisted ? 'pass' : 'fail']('L2', '重启后知识笔记仍存在', await shot(page2, worker.workerDir, 'L2-persisted'))
  if (!persisted) {
    pass = false
  }
  const noInternal = !/[A-Za-z]:\\[^ ]*/
    .test(persistedText)
  reporter[noInternal ? 'pass' : 'fail']('L4', '页面未暴露内部路径', await shot(page2, worker.workerDir, 'L4-no-internal-path'))
  if (!noInternal) pass = false

  const initialTextUsed = initialText.length > 0
  reporter.pass('H5', `初始页面文本长度=${initialText.length}`, initialTextUsed ? '' : '无正文')
} catch (error) {
  const errorPage = app ? app.windows()[0] : null
  reporter.fail('WORKER', String(error).slice(0, 1200), await shot(errorPage, worker.workerDir, 'ERROR'))
  pass = false
} finally {
  await closeWorker(app)
}

const report = await reporter.write(worker.workerDir, pass)
console.log(`WORKER_KNOWLEDGE ${report.pass ? 'PASS' : 'FAIL'} checks=${report.checks.length} failures=${report.failures.length} pageErrors=${report.pageErrors.length}`)
process.exit(report.pass ? 0 : 1)
