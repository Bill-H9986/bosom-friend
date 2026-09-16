/**
 * 任务详情「刷新后状态」探针：直接打开详情页 / 从列表点进去再刷新，看标题、收藏、评分是否还在。
 * 用法：node products/bosom-friend/qa/probes/probe-task-detail-reload.mjs
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const API = BASE + 'api/'
const OUT = join(import.meta.dirname, 'agent-board')
const report = { base: BASE, at: new Date().toISOString() }

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

/** 读详情页顶部与评分区表现。 */
async function readDetail(page) {
  const main = (await page.locator('#main-content').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
  return {
    headerFavorited: /取消收藏/.test(main),
    hasRateEntry: /评分/.test(main),
    titleShown: main.slice(0, 40),
    mainSnippet: main.slice(0, 160),
  }
}

// 用一条已完成任务做样本，并临时打上评分与收藏
const list = await api('GET', 'agent/tasks?page=1&pageSize=20')
const sample = (list?.data?.list ?? []).find(item => item.status === 'completed')
if (sample === undefined) {
  console.log('TASK_DETAIL_RELOAD SKIP 没有已完成任务')
  process.exit(2)
}
report.taskId = sample.id
report.apiBefore = { rating: sample.rating, favorite: sample.favorite }
await api('POST', 'agent/tasks/' + sample.id + '/rating', { rating: 5, comment: '刷新保持自检' })
await api('POST', 'agent/tasks/' + sample.id + '/favorite')
report.apiAfterPatch = (await api('GET', 'agent/tasks/' + sample.id))?.data

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  // 路径一：全新上下文直接打开详情 URL（等价于刷新/分享进来的冷启动）
  const cold = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const coldPage = await cold.newPage()
  await coldPage.goto(BASE + '#/chat/' + sample.id, { waitUntil: 'domcontentloaded' })
  await coldPage.waitForTimeout(8000)
  await acceptDisclaimer(coldPage)
  await coldPage.waitForTimeout(3000)
  report.coldOpen = { url: coldPage.url(), ...(await readDetail(coldPage)) }
  await coldPage.screenshot({ path: join(OUT, '14-detail-cold-open.png') })
  await cold.close()

  // 路径二：从「我的任务」点进去，再刷新
  const warm = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const warmPage = await warm.newPage()
  await warmPage.goto(BASE + '#/tasks-history', { waitUntil: 'domcontentloaded' })
  await warmPage.waitForTimeout(7000)
  await acceptDisclaimer(warmPage)
  const item = warmPage.locator('[class*=cursor-pointer]').filter({ hasText: sample.title.slice(0, 10) }).first()
  if (await item.count() > 0) {
    await item.click()
    await warmPage.waitForTimeout(5000)
    report.afterClick = { url: warmPage.url(), ...(await readDetail(warmPage)) }
    await warmPage.screenshot({ path: join(OUT, '15-detail-after-click.png') })
    await warmPage.reload({ waitUntil: 'domcontentloaded' })
    await warmPage.waitForTimeout(8000)
    report.afterReload = { url: warmPage.url(), ...(await readDetail(warmPage)) }
    await warmPage.screenshot({ path: join(OUT, '16-detail-after-reload.png') })
  }
  else {
    report.afterClick = { missing: '列表里没找到样本任务' }
  }
  await warm.close()
}
finally {
  await api('POST', 'agent/tasks/' + sample.id + '/rating', { rating: sample.rating ?? 0, comment: '' })
  if (sample.favorite !== true) await api('DELETE', 'agent/tasks/' + sample.id + '/favorite')
  await browser.close()
}
writeFileSync(join(import.meta.dirname, 'probe-task-detail-reload-report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log('TASK_DETAIL_RELOAD ' + JSON.stringify({ cold: report.coldOpen, click: report.afterClick, reload: report.afterReload }))
