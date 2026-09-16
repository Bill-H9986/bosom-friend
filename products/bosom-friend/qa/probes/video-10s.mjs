#!/usr/bin/env node
/** 10 秒视频真实生成：提交后轮询页面“刚刚+成功/失败”，出截图。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const ev = (n) => join(repoRoot, 'products/bosom-friend/qa/evidence/gate', n)
const topic = '关于人社局无人机装调检修工程师就业免费培训'
const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(800)
  const di = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  await di.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); await page.keyboard.type(topic)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(700)
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
  await page.locator('[data-testid="draftbox-ai-duration"]').first().click()
  await page.waitForTimeout(700)
  await page.getByText('10 秒', { exact: true }).last().click().catch(async () => { await page.getByText('10 秒', { exact: true }).first().click() })
  await page.waitForTimeout(500)
  console.log('DUR_PILL=' + await page.locator('[data-testid="draftbox-ai-duration"]').first().textContent().catch(() => ''))
  await page.locator('[data-testid="draftbox-ai-submit-btn"]').first().click()
  console.log('VIDEO10_SUBMIT')
  await page.waitForTimeout(6000)
  await page.getByText('生成记录', { exact: true }).last().click().catch(() => {})
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(15000)
    const body = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ') ?? ''
    const fresh = /刚刚/.test(body) && /成功|失败|已生成|被中断/.test(body)
    console.log('W' + (i + 1) + ' fresh=' + fresh)
    if (fresh) break
  }
  await page.screenshot({ path: ev('video-10s-final.png') }).catch(() => {})
  const tail = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ').slice(-260) ?? ''
  console.log('VIDEO10_TAIL=' + tail)
} finally {
  if (process.env.KEEP_ALIVE !== '1') {
    try { const w = app.windows()[0]; if (w) await w.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {}); await new Promise(r => setTimeout(r, 1500)) } catch {}
    try { await app.close().catch(() => {}) } catch {}
  } else {
    console.log('KEEP_ALIVE=1 app保持运行，生成将后台继续')
  }
}
