#!/usr/bin/env node
/** 门槛 7-10 快速段：模式菜单/提示词/平台/档位。只测不修。 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))
const ev = (n) => join(repoRoot, 'products/bosom-friend/qa/evidence/gate', n)
mkdirSync(ev(''), { recursive: true })

const log = (no, ok, detail) => console.log('GATE ' + no + ' ' + (ok ? 'GREEN' : 'RED') + ' ' + detail)
const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)
  // 7 模式菜单
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  const modes = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => /生成草稿|生成图片|生成视频/.test(t)).slice(0, 8))
  const onlyTwo = modes.filter((m) => m.includes('生成草稿')).length >= 2 && !modes.some((m) => /生成图片|生成视频/.test(m))
  log(7, onlyTwo, JSON.stringify(modes))
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: ev('gate-07-a.png') }).catch(() => {})
  // 8 提示词读回
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(800)
  const di = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  const topic = '关于人社局无人机装调检修工程师就业免费培训'
  await di.fill(topic)
  const readBack = (await di.innerText().catch(() => '')).trim()
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(700)
  const main = (await page.locator('[data-testid="draftbox-ai-prompt-input"]').first().innerText().catch(() => '')).trim()
  log(8, readBack === topic && main.includes(topic), '读回=' + JSON.stringify(readBack) + ' 主输入=' + JSON.stringify(main.slice(0, 30)))
  await page.screenshot({ path: ev('gate-08-a.png') }).catch(() => {})
  // 9 平台列表
  await page.getByText(/\d+ 个平台/).first().click()
  await page.waitForTimeout(800)
  const platform = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popover"]')).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).join(' | '))
  const hasDY = platform.includes('抖音')
  const hasXHS = platform.includes('小红书')
  log(9, hasDY, '平台=' + platform.slice(0, 120) + '（小红书=' + hasXHS + '，记前置）')
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: ev('gate-09-a.png') }).catch(() => {})
  // 10 档位 图文 vs 视频
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(图文)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
  await page.locator('[data-testid="draftbox-ai-resolution"]').first().click()
  await page.waitForTimeout(800)
  const imgTiers = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').trim()).filter((t) => /720p|1080p/.test(t)).slice(0, 6))
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
  await page.locator('[data-testid="draftbox-ai-video-resolution"]').first().click()
  await page.waitForTimeout(800)
  const vidTiers = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').trim()).filter((t) => /720p|1080p/.test(t)).slice(0, 6))
  const same = JSON.stringify(imgTiers) === JSON.stringify(vidTiers) && imgTiers.includes('720p') && imgTiers.includes('1080p')
  log(10, same, '图文=' + JSON.stringify(imgTiers) + ' 视频=' + JSON.stringify(vidTiers))
  await page.screenshot({ path: ev('gate-10-a.png') }).catch(() => {})
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
  } catch {}
  try { await app.close().catch(() => {}) } catch {}
}
