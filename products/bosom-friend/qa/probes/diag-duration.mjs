#!/usr/bin/env node
/** 诊断视频时长：pricing 返回 + 当前模型 + 时长选项(含禁用)。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  let pricing = ''
  page.on('response', async (res) => {
    if (res.url().includes('/ai/draft-generation/pricing') && res.request().method() === 'GET') pricing = await res.text().catch(() => '')
  })
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(1000)
  console.log('MODEL_LABEL=' + await page.locator('[data-testid="draftbox-ai-model"]').first().textContent().catch(() => ''))
  await page.locator('[data-testid="draftbox-ai-duration"]').first().click()
  await page.waitForTimeout(900)
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => ({ t: (el.textContent || '').trim(), dis: el.disabled === true })).filter((b) => /秒|分钟/.test(b.t)).slice(0, 14))
  console.log('DURATION_OPTIONS=' + JSON.stringify(opts))
  const p = JSON.parse(pricing || '{}')
  const vms = (p?.data?.videoModels || []).map((m) => ({ name: m.name, desc: m.description, durations: m.durations }))
  console.log('VIDEO_MODELS=' + JSON.stringify(vms).slice(0, 700))
} finally {
  try { const w = app.windows()[0]; if (w) await w.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {}); await new Promise(r => setTimeout(r, 1500)) } catch {}
  try { await app.close().catch(() => {}) } catch {}
}
