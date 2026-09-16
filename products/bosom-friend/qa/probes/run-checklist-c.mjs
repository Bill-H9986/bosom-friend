#!/usr/bin/env node
/** 清单 C 组：内容创作逐项前端测试（保持运行观察终态）。参数：none=全部 或 image|video 单跑某生成。 */
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

  // C1 模式菜单
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  const modes = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => /生成草稿|生成图片|生成视频/.test(t)).slice(0, 8))
  console.log('C1_MODES=' + JSON.stringify(modes))
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)

  // C2 提示词编辑+读回
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(800)
  const dialogInput = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  if (await dialogInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await dialogInput.fill(topic)
    const readBack = await dialogInput.innerText().catch(() => '')
    console.log('C2_READBACK=' + JSON.stringify(readBack))
    await page.getByText('保存', { exact: true }).first().click()
    await page.waitForTimeout(700)
    const mainInput = page.locator('[data-testid="draftbox-ai-prompt-input"]').first()
    console.log('C2_SAVED=' + JSON.stringify(await mainInput.innerText().catch(() => '')))
  } else {
    console.log('C2_PROMPT_BOX_NOT_FOUND')
  }

  // C3 平台选择
  await page.getByText(/\d+ 个平台/).first().click()
  await page.waitForTimeout(800)
  const platform = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popover"]')).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).join(' | '))
  console.log('C3_PLATFORMS=' + platform.slice(0, 240))
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)

  // 模式→图文；比例 9:16；档位 1080p
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(图文)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
  await page.locator('[data-testid="draftbox-ai-ratio"]').first().click()
  await page.waitForTimeout(500)
  await page.getByText('9:16', { exact: true }).last().click().catch(async () => { await page.getByText('9:16', { exact: true }).first().click() })
  await page.waitForTimeout(700)
  await page.locator('[data-testid="draftbox-ai-resolution"]').first().click()
  await page.waitForTimeout(900)
  const tiers = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0).map((el) => (el.textContent || '').trim()).filter((t) => /720p|1080p/.test(t)).slice(0, 6))
  console.log('C4_TIERS=' + JSON.stringify(tiers))
  const t1080 = page.getByText('1080p', { exact: true }).last()
  if (await t1080.isVisible({ timeout: 3000 }).catch(() => false)) {
    await t1080.click()
  } else {
    console.log('C4_1080P_NOT_IN_MENU')
  }
  await page.waitForTimeout(500)
  console.log('C4_TIER_LABEL=' + await page.locator('[data-testid="draftbox-ai-resolution"]').first().textContent().catch(() => ''))
  console.log('C5_RATIO_LABEL=' + await page.locator('[data-testid="draftbox-ai-ratio"]').first().textContent().catch(() => ''))

  // C10 素材上传（用仓库品牌图作测试图片）
  const fileInput = page.locator('input[type="file"]').first()
  if (await fileInput.count() > 0) {
    await fileInput.setInputFiles(join(repoRoot, 'products/bosom-friend/project/bosom-friend-electron/src/assets/logo.png'))
    await page.waitForTimeout(1500)
    const uploadOk = await page.getByText(/已上传|上传成功|logo|预览/).first().isVisible({ timeout: 3000 }).then(() => true).catch(() => false)
    console.log('C10_UPLOAD=' + uploadOk)
  } else {
    console.log('C10_FILE_INPUT_NOT_FOUND')
  }

  // C11/C12 提交并保持运行观察
  await page.screenshot({ path: ev('C-before-submit.png') }).catch(() => {})
  await page.locator('[data-testid="draftbox-ai-submit-btn"]').first().click()
  console.log('C11_SUBMIT_CLICKED')
  await page.waitForTimeout(6000)
  await page.screenshot({ path: ev('C-after-submit-6s.png') }).catch(() => {})
  await page.getByText('生成记录', { exact: true }).last().click().catch(() => {})
  let terminal = ''
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(15000)
    const text = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ').slice(-500) ?? ''
    await page.screenshot({ path: ev('C-poll-' + (i + 1) + '.png') }).catch(() => {})
    if (/(生成中|进行中)/.test(text)) {
      console.log('C12_STATE(gen)=第' + (i + 1) + '轮')
      continue
    }
    if (/(成功|已生成|已完成|失败|被中断)/.test(text)) {
      terminal = text
      break
    }
  }
  console.log('C12_TERMINAL=' + JSON.stringify(terminal.slice(0, 300)))

  // C13 草稿卡片 + C14 详情
  await page.locator('[role="tab"]').filter({ hasText: /^草稿/ }).first().click().catch(() => {})
  await page.waitForTimeout(2000)
  const cardCount = await page.locator('[data-testid="draftbox-draft-card"]').count()
  console.log('C13_DRAFT_CARDS=' + cardCount)
  const firstCard = page.locator('[data-testid="draftbox-draft-card"]').first()
  if (await firstCard.isVisible({ timeout: 4000 }).catch(() => false)) {
    await firstCard.click({ force: true })
    await page.waitForTimeout(1200)
    const detailVisible = await page.locator('[data-testid="draftbox-detail-delete-btn"]').isVisible({ timeout: 4000 }).then(() => true).catch(() => false)
    console.log('C14_DETAIL_OPEN=' + detailVisible)
    await page.screenshot({ path: ev('C14-detail.png') }).catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
  }
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
