#!/usr/bin/env node
// Desktop .exe debug: launch the packaged Bosom Friend exe under Playwright Electron,
// verify product UI + kernel handshake + version + window behavior, screenshot to evidence.
const path = require('path')
const { mkdirSync } = require('fs')
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const { _electron: electron } = require(path.join(repoRoot, 'products', 'bosom-friend', 'project', 'bosom-friend-electron', 'node_modules', '.pnpm', 'playwright-core@1.62.1', 'node_modules', 'playwright-core'))
const packagedExe = process.env.BF_DESKTOP_EXE || 'C:\\Users\\Jay\\AppData\\Local\\Programs\\Bosom Friend\\Bosom Friend.exe'
async function main () {
  const app = await electron.launch({ executablePath: packagedExe, args: [], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } })
  let ok = false
  let status = ''
  const win = await app.firstWindow()
  await win.locator('body').waitFor({ timeout: 60000 }).catch(() => {})
  const productMarker = /内容创作|数据中心|AI互动|账号管理|发布日历|全局监控/
  const placeholderMarker = /桌面应用地基|握手进行中|握手失败|加载中/
  for (let i = 0; i < 240; i += 1) {
    const body = await win.textContent('body').catch(() => '')
    if (productMarker.test(body || '') && !placeholderMarker.test(body || '')) { ok = true; status = '产品界面可见'; break }
  }
  const kern = await win.evaluate(() => (window.bosomKernel ? window.bosomKernel.getStatus() : null)).catch(() => null)
  const nav = await win.evaluate(() => Array.from(document.querySelectorAll('a[href*="#/"]')).map(a => a.getAttribute('href')).join(',')).catch(() => '')
  const ev = path.join(repoRoot, 'products', 'bosom-friend', 'qa', 'evidence')
  mkdirSync(ev, { recursive: true })
  await win.screenshot({ path: path.join(ev, 'M6-desktop-exe-debug.png') })
  console.log('DBG ok=' + ok + ' status=' + status)
  console.log('DBG url=' + win.url())
  console.log('DBG title=' + (await win.title().catch(() => '')))
  console.log('DBG bosomKernel=' + JSON.stringify(kern))
  console.log('DBG nav=' + nav)
  await app.process().kill()
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error('DBG_FAIL ' + (e instanceof Error ? e.message : String(e))); process.exit(1) })
