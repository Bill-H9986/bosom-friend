// 真机发布考试驱动：发送题目，等管家把事办完（直发或动作卡两条路），轮询真实平台结果。
// 2026-10-13：端口从 3080 更到 31280（开发版实际端口）；兼容 ADR-005 后的「管家直接发布」——
// 若记录先于「去发布」卡出现（AI 自己调 publish 工具），跳过卡片点击直接进入结果轮询。
// 2026-10-14：加 BF_PUBLISH_PLATFORM=xhs|douyin（默认 xhs），题目按平台措辞；其余判据不变。
import { createRequire } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const LOG = join(import.meta.dirname, 'real-machine-publish-events.jsonl')
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const APP = 'http://127.0.0.1:31280/bosom-friend/'
const API = 'http://127.0.0.1:31280/bosom-friend/api/'
const PLATFORM = (process.env.BF_PUBLISH_PLATFORM ?? 'xhs').trim() === 'douyin' ? 'douyin' : 'xhs'
const PLATFORM_LABEL = PLATFORM === 'douyin' ? '抖音' : '小红书'
const EXAM = '把草稿 cnt-ixkb2e82（《35岁转行无人机维修，我的一天实录》，已配封面）直接发布到' + PLATFORM_LABEL + '，不要发成别的内容，完成后把平台作品 ID 告诉我。'

function log(type, detail = '') {
  const line = JSON.stringify({ time: new Date().toISOString(), type, detail: String(detail).slice(0, 1600) })
  appendFileSync(LOG, line + '\n', 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
log('start', 'real machine publish driver platform=' + PLATFORM)
// 本轮开始时间：结果轮询只认它之后创建的记录（防第二次运行拿到上一轮的结果）。
const runStartIso = new Date().toISOString()

const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', error => {
  errors.push(String(error))
  log('pageerror', String(error))
})

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000)
  try {
    await page.locator("button:has-text('我已阅读并同意')").click({ timeout: 10000 })
    await page.locator("button:has-text('同意并进入平台')").click({ timeout: 10000 })
    await page.waitForTimeout(2500)
  } catch { /* already agreed */ }

  const input = page.locator('[data-testid=ai-assistant-sidebar] textarea, [data-testid=ai-assistant-sidebar] input').first()
  await input.fill(EXAM)
  await input.press('Enter')
  log('exam-sent', EXAM)

  const findCandidate = async () => {
    try {
      const records = await (await fetch(API + 'v2/channels/publish/records')).json()
      const list = records?.data?.records ?? []
      // 只认**本轮**新记录（runStartIso 之后创建的），否则第二次运行时会把上一轮的记录当成结果。
      const fresh = list
        .filter(r => r.title.includes('无人机') && r.publishTime >= runStartIso)
        .sort((a, b) => String(b.publishTime).localeCompare(String(a.publishTime)))
      return fresh[0] ?? null
    } catch { return null }
  }

  // 2026-10-13（DEF-303 处置）：驱动**不再点击「去发布」卡片**——卡片+弹窗路径实测会把助手
  // 回复当成发布内容。这里只等「管家直发」产生的记录；卡片出现仅记日志（它本身是一个问题信号）。
  let sawCard = false
  let directRecord = null
  for (let i = 0; i < 100; i++) {
    await page.waitForTimeout(3000)
    directRecord = await findCandidate()
    if (directRecord !== null) {
      log('direct-publish-detected', `after ${(i + 1) * 3}s id=${directRecord.id} status=${directRecord.status}`)
      break
    }
    if (!sawCard && await page.locator('button:has-text("去发布")').count() > 0) {
      sawCard = true
      log('action-card-seen-no-click', '按 DEF-303 处置：驱动不点卡片，只等管家直发记录')
    }
  }
  if (directRecord === null) {
    throw new Error(sawCard
      ? '仅出现「去发布」卡片、管家未直发（驱动按 DEF-303 不再点卡）——记录未出现'
      : '300 秒内没有任何发布记录（管家未发起发布）')
  }

  const startTime = Date.now()
  let publishedRecord = null
  // 2026-10-13（DEF-305）：引擎回读预算 20 分钟（墙上时钟）、服务端总预算 45 分钟，
  // 驱动的观察窗必须覆盖到终态——600 秒会在回读途中提前退出，看不到引擎写回的结果。
  while (Date.now() - startTime < 2400000) {
    await page.waitForTimeout(3000)
    // 只认**本轮**新记录，且与探测阶段共用同一个 findCandidate（2026-10-13：两处重复逻辑
    // 只改了探测段，轮询段还在用「1 小时窗」旧口径，第三轮把上一轮记录当成了本轮结果）。
    const candidate = await findCandidate()
    if (candidate) {
      publishedRecord = candidate
      log('record-state', `id=${candidate.id} status=${candidate.status} error=${candidate.errorMsg || ''} link=${candidate.workLink || ''}`)
      if (candidate.status === 1) break
      if (candidate.status === -1) throw new Error('publish failed: ' + (candidate.errorMsg || 'unknown'))
    }
  }
  if (!publishedRecord || publishedRecord.status !== 1) throw new Error('publish did not succeed')

  log('publish-success', JSON.stringify({ id: publishedRecord.id, workLink: publishedRecord.workLink, title: publishedRecord.title }))
  const accounts = await (await fetch(API + 'v2/channels/accounts')).json()
  const dashboard = await (await fetch(API + 'v2/statistics/published-content-summary/dashboard')).json()
  log('verify-data', JSON.stringify({ accounts: accounts.data.list.map(a => ({ nick: a.nickname, uid: a.uid, workCount: a.workCount })), workCount: dashboard.data.overall.workCount }))
  const reception = await (await fetch(API + 'v2/customer-reception/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '请问什么时候发货', platform: 'xhs' }),
  })).json()
  log('verify-reception', JSON.stringify(reception.data))

  await page.goto(APP + '#/accounts', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  await page.goto(APP + '#/monitor', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  try {
    await page.screenshot({ path: join(import.meta.dirname, 'real-machine-publish-final.png'), fullPage: true })
    log('final-page-ok', 'accounts+monitor loaded')
  } catch (error) {
    // 截图失败（文件被占用等）不掩盖已经取得的发布证据；如实记一条。
    log('screenshot-failed', String(error))
  }
} catch (error) {
  log('fatal', String(error))
  process.exitCode = 1
} finally {
  log('errors', errors.slice(0, 10).join(' | '))
  await browser.close()
}
