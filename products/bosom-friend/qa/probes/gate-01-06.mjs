#!/usr/bin/env node
/** 发布门槛 1-6：启动/品牌页/托盘/完全退出/导航。只测不修。 */
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const ev = (n) => join(repoRoot, 'products/bosom-friend/qa/evidence/gate', n)
const exe = process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe'
import { mkdirSync } from 'node:fs'
mkdirSync(ev(''), { recursive: true })

const countProc = () => {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Bosom Friend.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return out.trim() === '' ? 0 : out.trim().split(/\r?\n/).length
  } catch { return 0 }
}

const R = []
const log = (no, ok, detail) => { R.push({ no, ok: ok ? 'GREEN' : 'RED', detail }); console.log('GATE ' + no + ' ' + (ok ? 'GREEN' : 'RED') + ' ' + detail) }

const app = await electron.launch({ executablePath: exe })
let spawnedPid = 0
try {
  const page = await app.firstWindow()
  await page.waitForTimeout(600)
  const t0 = Date.now()
  // 1 启动页品牌化
  await page.screenshot({ path: ev('gate-01-a.png') }).catch(() => {})
  const splash = (await page.textContent('body').catch(() => '')) || ''
  const hasTech = /握手|进程|地基|stderr|file:\/\//.test(splash)
  log(1, !hasTech && /Bosom Friend|正在启动/.test(splash), '品牌启动页无技术词=' + (!hasTech))
  // 2 产品首页 ≤10s
  let productOk = false
  try {
    await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 10000 })
    productOk = true
  } catch {}
  log(2, productOk, '10秒内首页可见')
  const ms = Date.now() - t0
  await page.screenshot({ path: ev('gate-02-a.png') }).catch(() => {})
  // 6 导航 7 项
  const items = ['内容创作', 'AI互动', '我的任务', '发布日历', '数据中心', '全局监控', '知识库']
  let navFail = ''
  for (const label of items) {
    const el = page.locator('[data-testid^="sidebar-nav-item"]').filter({ hasText: label }).first()
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click().catch(() => {})
      await page.waitForTimeout(1500)
      await page.screenshot({ path: ev('gate-06-' + label + '.png') }).catch(() => {})
      const len = ((await page.textContent('body').catch(() => '')) || '').length
      if (len < 300) navFail += label + '(' + len + ') '
    } else {
      navFail += label + '(absent) '
    }
  }
  log(6, navFail === '', '7项导航全部有内容' + (navFail ? '；缺：' + navFail : ''))
  // 3 关窗=托盘（进程保留）
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  await page.waitForTimeout(1500)
  log(3, countProc() > 0, '关闭窗口后进程数=' + countProc())
  await page.screenshot({ path: ev('gate-03-a.png') }).catch(() => {})
  // 5 完全退出（主进程 quit → 后续自检进程清零）
  await page.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
  await page.waitForTimeout(6000)
  const afterExit = countProc()
  log(5, afterExit === 0, '完全退出后进程数=' + afterExit)
  // 4 再次启动可见
  const second = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
  spawnedPid = second.pid
  second.unref()
  await page.waitForTimeout(12000)
  log(4, countProc() > 0, '再次启动进程数=' + countProc())
  await page.screenshot({ path: ev('gate-04-a.png') }).catch(() => {})
  console.log('GATE_1_6_SUMMARY ' + JSON.stringify(R))
} finally {
  try { await app.close().catch(() => {}) } catch {}
}
