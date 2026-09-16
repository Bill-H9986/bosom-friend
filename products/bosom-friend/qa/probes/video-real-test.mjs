#!/usr/bin/env node
/** 视频真实生成测试：草稿(视频)、9:16、720p、5秒；保持运行看终态。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const ev = (n) => join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04', n)
const topic = '关于人社局无人机装调检修工程师就业免费培训'

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  // 提示词
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(800)
  const di = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  await di.fill(topic)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(700)
  // 模式=视频，比例=9:16，档位=720p，时长=5秒
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
  await page.locator('[data-testid="draftbox-ai-ratio"]').first().click()
  await page.waitForTimeout(500)
  await page.getByText('9:16', { exact: true }).last().click().catch(async () => { await page.getByText('9:16', { exact: true }).first().click() })
  await page.waitForTimeout(600)
  console.log('VIDEO_MODE=' + await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().textContent().catch(() => ''))
  console.log('VIDEO_RES=' + await page.locator('[data-testid="draftbox-ai-video-resolution"]').first().textContent().catch(() => ''))
  console.log('VIDEO_RATIO=' + await page.locator('[data-testid="draftbox-ai-ratio"]').first().textContent().catch(() => ''))
  console.log('VIDEO_DUR=' + await page.locator('[data-testid="draftbox-ai-duration"]').first().textContent().catch(() => ''))
  await page.locator('[data-testid="draftbox-ai-submit-btn"]').first().click()
  console.log('VIDEO_SUBMIT_CLICKED')
  await page.waitForTimeout(6000)
  await page.getByText('生成记录', { exact: true }).last().click().catch(() => {})
  let terminal = ''
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(15000)
    const text = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ').slice(-500) ?? ''
    await page.screenshot({ path: ev('VID-poll-' + (i + 1) + '.png') }).catch(() => {})
    if (/(成功|已生成|失败|被中断|超时)/.test(text) && !/生成中|进行中/.test(text)) {
      terminal = text
      break
    }
  }
  console.log('VIDEO_TERMINAL=' + JSON.stringify((terminal || '').slice(0, 300)))
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
