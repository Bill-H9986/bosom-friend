#!/usr/bin/env node
/**
 * 更新检查的桌面壳验收：在**真实 Electron 窗口**里走一遍「设置 → 系统与更新 → 检查更新」。
 *
 * 为什么不能用无头 Chromium：preload 暴露的 bosomUpdate 桥只存在于 Electron 窗口里；
 * 普通浏览器打开同一个 URL 时那个桥是 undefined（设置页会如实隐藏整段桌面功能），
 * 于是"桥通不通"这件事只能在这里验。
 *
 * Usage: node products/bosom-friend/qa/probes/update-check-electron-verify.mjs [expectedVersion]
 * @module qa/probes/update-check-electron-verify
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const OUT = join(HERE, '..', 'evidence', 'update-check-2026-09-20')
mkdirSync(OUT, { recursive: true })
const EXPECTED = process.argv[2] ?? '9.9.9'
// 复用 qa/e2e 的本地 playwright（qa 根目录没有 package.json，裸包名解析不到）。
const { _electron: electron } = require(join(PRODUCT, 'qa', 'e2e', 'node_modules', 'playwright', 'test.js'))

const checks = []
/** 记录断言。 @param name - 断言名。 @param ok - 是否通过。 @param detail - 证据。 */
function check(name, ok, detail) { checks.push({ name, ok, detail: detail ?? '' }); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' | ' + (detail ?? '')) }

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'Bosom Friend.exe') })
try {
  const page = await app.firstWindow()
  await page.waitForTimeout(9000)
  const bridge = await page.evaluate(() => ({
    hasUpdate: typeof window.bosomUpdate,
    checkType: typeof window.bosomUpdate?.check,
    electron: navigator.userAgent.includes('Electron'),
  }))
  check('Electron 窗口里 preload 暴露了 bosomUpdate 桥', bridge.checkType === 'function', JSON.stringify(bridge))

  const manifestUrl = await page.evaluate(async () => await window.bosomUpdate.getManifestUrl())
  console.log('MAIN_READS_MANIFEST ' + String(manifestUrl))
  check('主进程读到的清单地址是本地夹具', String(manifestUrl).includes('32199'), String(manifestUrl))
  console.log('CHECK_START 调用 window.bosomUpdate.check() …')
  const direct = await page.evaluate(async () => {
    // 带超时：主进程若卡住，这里要如实报"超时"，而不是让整个验收挂着。
    return await Promise.race([
      window.bosomUpdate.check(),
      new Promise(resolve => setTimeout(() => resolve({ update: false, reason: 'error', message: '验收：15 秒内没有返回' }), 15000)),
    ])
  })
  console.log('CHECK_DONE ' + JSON.stringify(direct).slice(0, 220))
  check('桥能真的拉起更新检查', typeof direct === 'object' && direct !== null, JSON.stringify(direct).slice(0, 200))
  check('清单报的更高版本被识别', String(direct?.newVersion) === EXPECTED, 'newVersion=' + String(direct?.newVersion) + ' update=' + String(direct?.update))

  // 用应用自己的导航进设置：点左下角账号区（面板里就是设置入口）。
  // 不用 page.goto 重新加载：主进程窗口一重载会触发进程编排，实测静默退出。
  console.log('NAV_TO_SETTINGS 走侧栏账号菜单里的设置入口 …')
  await page.getByText('Bosom Friend客户端').first().click({ timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(2000)
  const entry = page.locator('[data-testid="sidebar-settings-entry"]').first()
  check('侧栏账号菜单里有设置入口', await entry.count() > 0, 'count=' + String(await entry.count()))
  await entry.click({ timeout: 20000 })
  await page.waitForTimeout(4000)
  console.log('NAV_DONE 设置弹层已打开')
  await page.getByText('系统与更新', { exact: true }).first().click({ timeout: 20000 })
  await page.waitForTimeout(2500)
  await page.getByText(/开发者选项/).first().click({ timeout: 20000 })
  await page.waitForTimeout(1200)
  const input = page.locator('[data-testid="update-manifest-url"]').first()
  check('设置页渲染出桌面端更新区', await input.count() > 0, 'count=' + String(await input.count()))
  await page.locator('[data-testid="update-check"]').first().click()
  await page.waitForTimeout(7000)
  const result = ((await page.locator('[data-testid="update-result"]').first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
  check('页面如实显示发现新版本', result.includes(EXPECTED), result.slice(0, 180))
  const download = page.locator('[data-testid="update-open-download"]').first()
  check('给出可用的「打开下载页」按钮', await download.count() > 0 && !(await download.isDisabled()), 'count=' + String(await download.count()))
  await page.screenshot({ path: join(OUT, 'electron-update.png') }).catch(() => {})
  writeFileSync(join(OUT, 'electron-update-report.json'), JSON.stringify({ bridge, direct, checks }, null, 2), 'utf8')
  const failed = checks.filter(item => !item.ok).length
  console.log('UPDATE_CHECK_ELECTRON ' + (failed === 0 ? 'PASS' : 'FAIL') + ' checks=' + String(checks.length) + ' fail=' + String(failed))
} finally {
  await app.close().catch(() => {})
}
process.exit(checks.some(item => !item.ok) ? 1 : 0)
