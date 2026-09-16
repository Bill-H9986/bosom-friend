/**
 * AC-014（任务记录）前端证据探针：列表/详情的状态与时间是否真的可见，评分与收藏刷新后是否还在。
 *
 * 做法：造一条自检任务 → 评分 5 星 + 收藏 → 打开「我的任务」搜到它（截图）→ 打开详情（截图）
 * → 刷新页面再看一次（截图）→ 删除这条自检任务。全程不动用户自己的任务。
 *
 * 用法：node products/bosom-friend/qa/probes/probe-task-record-evidence.mjs
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const API = BASE + 'api/'
const OUT = join(import.meta.dirname, 'agent-board')
const TITLE = '自检任务-' + String(Date.now()).slice(-6)
const report = { base: BASE, at: new Date().toISOString(), title: TITLE }

const api = async (method, path, body) => {
  const response = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return response.json().catch(() => null)
}

async function acceptDisclaimer(page) {
  for (let i = 0; i < 8; i++) {
    for (const label of ['我已阅读并同意', '同意并进入平台']) {
      const button = page.locator("button:has-text('" + label + "')").first()
      if (await button.count() > 0 && await button.isVisible().catch(() => false))
        await button.click({ timeout: 3000 }).catch(() => {})
    }
    await page.waitForTimeout(400)
  }
}

// 造一条真实跑完的自检任务（走 SSE，和前端同一条路径），再打上评分与收藏
const taskId = await (async () => {
  const response = await fetch(API + 'agent/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ prompt: TITLE + '：用一句话说明这条任务记录是用来验收的。', includePartialMessages: true }),
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let id = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done === true) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const line = block.split('\n').find(item => item.startsWith('data:'))
      if (line === undefined) continue
      try {
        const payload = JSON.parse(line.replace(/^data:\s*/, ''))
        if (payload.type === 'init' && id === null) id = payload.taskId
      } catch { /* 心跳 */ }
    }
  }
  return id
})()
report.taskId = taskId
if (taskId === null) {
  console.log('TASK_RECORD_EVIDENCE SKIP 没能创建自检任务')
  process.exit(2)
}
await api('POST', 'agent/tasks/' + taskId + '/rating', { rating: 5, comment: '自检评分' })
await api('POST', 'agent/tasks/' + taskId + '/favorite')
const afterPatch = (await api('GET', 'agent/tasks/' + taskId))?.data
report.apiAfterPatch = { status: afterPatch?.status, rating: afterPatch?.rating, favorite: afterPatch?.favorite }

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(7000)
  await acceptDisclaimer(page)

  // 列表：搜到这条自检任务
  await page.goto(BASE + '#/tasks-history', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  const search = page.locator('input[placeholder*="搜索"], input[type=search]').first()
  if (await search.count() > 0) {
    await search.fill(TITLE)
    await page.waitForTimeout(4000)
  }
  const listText = (await page.locator('#main-content').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
  report.listShows = { title: listText.includes(TITLE), hasTime: /刚刚|分钟前|小时前|\d{1,2}:\d{2}/.test(listText), hasStatus: /已完成|进行中|失败/.test(listText) }
  await page.screenshot({ path: join(OUT, '11-task-history-list.png') })

  // 详情
  const item = page.locator('[class*=cursor-pointer]').filter({ hasText: TITLE }).first()
  if (await item.count() > 0) {
    await item.click()
    await page.waitForTimeout(5000)
    const detailText = (await page.locator('#main-content').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
    report.detailShows = { title: detailText.includes(TITLE), hasFavorite: /收藏/.test(detailText), hasRating: /评分|★/.test(detailText) }
    await page.screenshot({ path: join(OUT, '12-task-detail.png') })
  }

  // 刷新后评分/收藏仍在
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  const reloaded = (await api('GET', 'agent/tasks/' + taskId))?.data
  report.afterReload = { rating: reloaded?.rating, favorite: reloaded?.favorite }
  await page.screenshot({ path: join(OUT, '13-task-detail-after-reload.png') })
  await context.close()
}
finally {
  await api('DELETE', 'agent/tasks/' + taskId)
  report.cleaned = true
  await browser.close()
}
writeFileSync(join(import.meta.dirname, 'probe-task-record-report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log('TASK_RECORD_EVIDENCE ' + JSON.stringify({ list: report.listShows, detail: report.detailShows, afterReload: report.afterReload }))
