#!/usr/bin/env node
/**
 * M6 桌面端到端冒烟：启动 Electron 桌面壳，验证页面真实显示内核握手状态。
 * 运行：node products/bosom-friend/qa/m6-electron-smoke.cjs
 */
const path = require('path')
const { mkdirSync } = require('fs')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const { _electron: electron } = require(repoRoot + '/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const packagedExe = process.env.BF_DESKTOP_EXE
const electronExe = packagedExe
  || path.join(repoRoot, 'products', 'bosom-friend', 'project', 'bosom-friend-electron', 'node_modules', 'electron', 'dist', 'electron.exe')
const desktopDir = path.join(repoRoot, 'products', 'bosom-friend', 'desktop')

async function main() {
  const app = await electron.launch({
    executablePath: electronExe,
    args: packagedExe ? [] : [desktopDir],
    cwd: desktopDir,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
  })
  let ok = false
  let status = ''
  try {
    const win = await app.firstWindow()
    await win.locator('body').waitFor({ timeout: 60000 }).catch(() => {})
    const productMarker = /内容创作|数据中心|AI互动|账号管理|发布日历/
    const placeholderMarker = /桌面应用地基|握手进行中|握手失败/
    for (let i = 0; i < 240; i += 1) {
      const body = await win.textContent('body').catch(() => '')
      const hasProduct = productMarker.test(body || '')
      const hasPlaceholder = placeholderMarker.test(body || '')
      if (hasProduct && !hasPlaceholder) {
        ok = true
        status = '产品界面可见'
        break
      }
      if (hasPlaceholder && !hasProduct) {
        status = '仍是占位页'
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
    if (!ok) status = '产品界面未出现'
    if (!ok) {
      console.log('M6_DIAG url=' + win.url())
      console.log('M6_DIAG title=' + (await win.title().catch(() => '')))
      const mainStatus = await win.evaluate(() => window.bosomKernel ? window.bosomKernel.getStatus() : null).catch(() => null)
      console.log('M6_DIAG mainStatus=' + JSON.stringify(mainStatus))
      console.log('M6_DIAG content=' + (await win.content().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300))
    }
    const evidenceDir = path.join(repoRoot, 'products', 'bosom-friend', 'qa', 'evidence')
    mkdirSync(evidenceDir, { recursive: true })
    await win.screenshot({ path: path.join(evidenceDir, 'M6-electron-kernel.png') })
    console.log('M6_ELECTRON kernelStatus=' + status)
  }
  finally {
    app.process().kill()
  }
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.error('M6_ELECTRON_FAIL ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
