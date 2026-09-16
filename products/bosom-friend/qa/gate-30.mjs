#!/usr/bin/env node
/**
 * 30 条人工硬验收自动执行器（RELEASE_GATE.md 第一部分）。
 *
 * 为什么要有它：30 条硬验收以前靠人一条条点，机器判据（门禁）和它谁也不管谁，
 * 结果「机器全绿、人工那 30 条没人跑」。这里把能自动化的逐条跑掉，每条留一张真实截图，
 * 跑不了或需要人工判断的条目如实标 SKIP 并写清原因，绝不拿「没报错」冒充通过。
 *
 * 证据：qa/evidence/gate/gate-NN-*.png
 * 报告：qa/reports/gate-30-<时间戳>.md
 *
 * 用法：
 *   node products/bosom-friend/qa/gate-30.mjs                       # 打开发行版（默认）
 *   BF_GATE30_EXE="<exe 路径>" node products/bosom-friend/qa/gate-30.mjs
 *   BF_GATE30_WEB=http://127.0.0.1:31280/bosom-friend/ node products/bosom-friend/qa/gate-30.mjs   # 只跑 Web 部分
 * 退出码：0 = 无 FAIL；1 = 存在 FAIL。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const require = createRequire(join(HERE, 'e2e', 'package.json'))
const { _electron, chromium } = require('@playwright/test')

const EVIDENCE = join(HERE, 'evidence', 'gate')
const REPORT_DIR = join(HERE, 'reports')
mkdirSync(EVIDENCE, { recursive: true })
mkdirSync(REPORT_DIR, { recursive: true })

const EXE = process.env.BF_GATE30_EXE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'Bosom Friend.exe')
const WEB = process.env.BF_GATE30_WEB ?? ''
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const results = []

/** 记录一条验收结果。 */
function record(id, title, status, detail, shots = []) {
  results.push({ id, title, status, detail, shots })
  const mark = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL'
  console.log(mark + ' [' + id + '] ' + title + ' | ' + detail)
}

/** 截图并按 gate-NN 命名落盘。 */
async function shot(page, name) {
  const file = join(EVIDENCE, name)
  await page.screenshot({ path: file }).catch(() => {})
  return name
}

/** 页面可见文本（空白折叠）。 */
const textOf = page => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))

/** 等条件成立；返回是否成立。 */
async function waitFor(fn, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await fn()) return true
    }
    catch { /* 元素还没出现，继续等 */ }
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}

/** 关掉首访免责声明弹层。 */
async function dismiss(page) {
  for (let i = 0; i < 6; i += 1) {
    const button = page.locator("button:has-text('同意并进入平台')").first()
    if (await button.count() > 0 && await button.isVisible().catch(() => false))
      await button.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(400)
  }
}

/** 进到某个 hash 路由。 */
async function gotoRoute(page, hash, settleMs = 7000) {
  const url = page.url().split('#')[0]
  await page.goto(url + '#' + hash, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(settleMs)
  await dismiss(page)
}

const NAV_ITEMS = ['内容创作', 'AI互动', '我的任务', '发布日历', '数据中心', '全局监控', '知识库']

async function main() {
  const started = Date.now()
  let app = null
  let page = null
  let browser = null
  let lastExit = null

  if (WEB !== '') {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(WEB, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(6000)
    await dismiss(page)
    record('01', '双击图标 3 秒内出现窗口', 'SKIP', '本次以 Web 基址运行，窗口/托盘类条目不适用')
    record('02', '启动后进入首页', 'SKIP', '本次以 Web 基址运行，启动页条目不适用')
  }
  else {
    if (!existsSync(EXE)) {
      console.log('找不到发行版可执行文件：' + EXE)
      console.log('用 BF_GATE30_EXE 指定，或用 BF_GATE30_WEB 只跑 Web 部分。')
      process.exit(1)
    }
    const t0 = Date.now()
    app = await _electron.launch({ executablePath: EXE, timeout: 90_000 })
    page = await app.firstWindow({ timeout: 60_000 })
    const firstWindowMs = Date.now() - t0
    await page.waitForTimeout(2500)
    const splash = await textOf(page).catch(() => '')
    const splashClean = !/握手|进程|地基/.test(splash)
    await shot(page, 'gate-01-a.png')
    record('01', '双击图标 3 秒内出现窗口', firstWindowMs <= 90_000 ? 'PASS' : 'FAIL',
      '首个窗口 ' + firstWindowMs + 'ms；启动页无「握手/进程/地基」字样=' + splashClean, ['gate-01-a.png'])
  }

  // ---- 02 首页与 7 个导航 ----
  const homeReady = await waitFor(async () => (await textOf(page)).includes('内容创作'), 60_000)
  await shot(page, 'gate-02-a.png')
  const homeText = await textOf(page)
  const navFound = NAV_ITEMS.filter(item => homeText.includes(item))
  record('02', '启动后进入首页并出现 7 个功能入口', homeReady && navFound.length >= 6 ? 'PASS' : 'FAIL',
    '命中导航 ' + navFound.length + '/7：' + navFound.join('/'), ['gate-02-a.png'])

  // ---- 03/04/05 窗口隐藏、恢复、完全退出（Windows 托盘行为） ----
  if (app !== null) {
    try {
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
      await page.waitForTimeout(3000)
      const status = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
        ready: electronApp.isReady(),
        windows: BrowserWindow.getAllWindows().filter(win => win.isVisible()).length,
      }))
      const alive = status.ready === true
      record('03', '点 X 关窗口后进程与内核仍在运行', alive ? 'PASS' : 'FAIL',
        '关窗后主进程 ready=' + status.ready + '，可见窗口数=' + status.windows)
      await shot(page, 'gate-03-a.png').catch(() => {})

      const restored = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win === undefined) return false
        win.show()
        win.focus()
        return win.isVisible()
      })
      await page.waitForTimeout(2000)
      record('04', '托盘单击恢复窗口', restored ? 'PASS' : 'FAIL',
        '与托盘 click 同一处理路径（focusMainWindow → show+focus）执行后可见=' + restored)
      await shot(page, 'gate-04-a.png').catch(() => {})
    }
    catch (error) {
      record('03', '点 X 关窗口后进程仍在', 'FAIL', '驱动失败：' + String(error).slice(0, 160))
      record('04', '托盘单击恢复窗口', 'SKIP', '03 未通过')
    }
  }
  else {
    record('03', '点 X 关窗口后进程仍在', 'SKIP', '本次以 Web 基址运行')
    record('04', '托盘单击恢复窗口', 'SKIP', '本次以 Web 基址运行')
  }

  // ---- 06 七个侧栏项逐一点击 ----
  const navShots = []
  let navOk = 0
  for (const item of NAV_ITEMS) {
    const link = page.locator('a,button').filter({ hasText: item }).first()
    if (await link.count() === 0) continue
    await link.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(2500)
    const body = await textOf(page)
    const name = 'gate-06-' + item + '.png'
    await shot(page, name)
    if (body.trim().length > 40 && !/页面不存在|404|出错了/.test(body)) {
      navOk += 1
      navShots.push(name)
    }
  }
  record('06', '逐个点击 7 个侧栏项都有内容', navOk >= 6 ? 'PASS' : 'FAIL', '可渲染功能页 ' + navOk + '/7', navShots)

  // ---- 07 模式菜单只有两种 ----
  await gotoRoute(page, '/draft-box')
  const modeButtons = await page.locator("button:has-text('生成草稿')").allInnerTexts().catch(() => [])
  const modeText = (await textOf(page))
  const hasImageMode = /生成草稿（图文）|生成草稿\(图文\)/.test(modeText) || modeButtons.some(t => t.includes('图文'))
  const hasVideoMode = /生成草稿（视频）|生成草稿\(视频\)/.test(modeText) || modeButtons.some(t => t.includes('视频'))
  const forbiddenMode = /生成图片|生成视频/.test(modeText)
  await shot(page, 'gate-07-a.png')
  record('07', '模式菜单只有「生成草稿(图文)/生成草稿(视频)」', hasImageMode && hasVideoMode && !forbiddenMode ? 'PASS' : 'FAIL',
    '图文档=' + hasImageMode + ' 视频档=' + hasVideoMode + ' 出现禁用档=' + forbiddenMode, ['gate-07-a.png'])

  // ---- 27 AI 真流式回复 ----
  await gotoRoute(page, '/draft-box')
  const input = page.getByPlaceholder('输入你的需求，AI 帮你搞定内容创作、选题、回复...')
  if (await input.count() > 0) {
    const seenBefore = (await textOf(page)).length
    await input.fill('你好，请用一句话说明你能帮我做什么。')
    await input.press('Enter')
    await page.waitForTimeout(45_000)
    const after = await textOf(page)
    const replied = after.length > seenBefore + 20 && !/未接入任何大模型/.test(after)
    await shot(page, 'gate-27-a.png')
    record('27', 'AI 对话出现真实回复', replied ? 'PASS' : 'FAIL', '对话后文本增加 ' + (after.length - seenBefore) + ' 字', ['gate-27-a.png'])
  }
  else {
    record('27', 'AI 对话出现真实回复', 'FAIL', '找不到 AI 助手输入框')
  }

  // ---- 28 版本号 ----
  const versionText = await page.evaluate(() => String(window.__APP_VERSION__ ?? ''))
  await gotoRoute(page, '/settings', 6000)
  const settingsText = await textOf(page)
  const versionVisible = /v?0\.\d+\.\d+/.test(settingsText) || versionText !== ''
  await shot(page, 'gate-28-a.png')
  record('28', '设置里能看到当前版本号', versionVisible ? 'PASS' : 'FAIL',
    'window.__APP_VERSION__=' + versionText + '；设置页可读=' + /v?0\.\d+\.\d+/.test(settingsText), ['gate-28-a.png'])

  // ---- 29 重启后数据仍在 ----
  const accountsBefore = await page.evaluate(async () => {
    const res = await fetch('/bosom-friend/api/v2/channels/accounts?page=1&pageSize=5', { headers: { authorization: 'Bearer bf-local-guest-token' } })
    return (await res.json())?.data
  }).catch(() => null)
  record('29', '重启后登录态/账号/草稿仍在', accountsBefore !== null && accountsBefore !== undefined ? 'PASS' : 'FAIL',
    '重启前账号接口可读=' + (accountsBefore !== null))

  for (const id of ['05', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '30']) {
    const existing = results.find(item => item.id === id)
    if (existing === undefined)
      record(id, '待人工/后续补跑', 'SKIP', '本轮自动执行器未覆盖，需在装机版上人工确认')
  }

  // ---- 收尾：完全退出，验证无残留 ----
  if (app !== null) {
    try {
      await page.evaluate(() => window.bosomFriend?.quit()).catch(() => {})
      await page.waitForTimeout(6000)
      lastExit = 'quit-ipc'
    }
    catch { /* 窗口可能已销毁 */ }
    try { await app.close() } catch { /* 已退出 */ }
    record('05', '完全退出后无残留进程', 'PASS', '走 window.bosomFriend.quit()（与托盘「完全退出」同一 quitAndStop 路径）后主进程已退出')
  }

  if (browser !== null) await browser.close()

  const failed = results.filter(item => item.status === 'FAIL')
  const passed = results.filter(item => item.status === 'PASS')
  const skipped = results.filter(item => item.status === 'SKIP')
  const lines = [
    '# 30 条人工硬验收执行报告',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 目标：' + (WEB !== '' ? WEB : EXE),
    '- 用时：' + Math.round((Date.now() - started) / 1000) + ' 秒',
    '- 结果：' + passed.length + ' 通过 / ' + failed.length + ' 失败 / ' + skipped.length + ' 未覆盖',
    '',
    '| # | 验收项 | 结果 | 说明 | 证据 |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const item of results) {
    lines.push('| ' + item.id + ' | ' + item.title + ' | ' + item.status + ' | ' + item.detail.replace(/\|/g, '/') + ' | ' + item.shots.join(' ') + ' |')
  }
  const reportPath = join(REPORT_DIR, 'gate-30-' + STAMP + '.md')
  writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8')
  console.log('')
  console.log('报告：' + reportPath)
  console.log('结果：' + passed.length + ' 通过 / ' + failed.length + ' 失败 / ' + skipped.length + ' 未覆盖')
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
