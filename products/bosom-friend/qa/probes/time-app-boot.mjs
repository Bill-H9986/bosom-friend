#!/usr/bin/env node
/** App 启动链路计时：窗口出现 / 内核握手完成 / 产品页可见。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron, expect } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const t0 = Date.now()
const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  console.log('APP_WINDOW_MS=' + (Date.now() - t0))
  await page.screenshot({ path: join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04/brand-splash.png') }).catch(() => {})
  for (let i = 0; i < 240; i += 1) {
    const st = await page.evaluate(() => window.bosomKernel?.getStatus?.().then((s) => ({ handshake: !!s.handshake, error: s.error || '' })).catch(() => null)).catch(() => null)
    if (st && st.handshake) {
      console.log('KERNEL_HANDSHAKE_MS=' + (Date.now() - t0))
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  const product = page.getByText(/内容创作|数据中心|AI互动/).first()
  await expect(product).toBeVisible({ timeout: 120000 })
  console.log('PRODUCT_MS=' + (Date.now() - t0))
  await page.screenshot({ path: join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04/product-home.png') }).catch(() => {})
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() })
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
