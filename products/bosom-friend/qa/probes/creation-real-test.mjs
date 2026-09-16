#!/usr/bin/env node
/** 清单第2条·严谨版：真实页面提交图文生成，保持运行并观察生成记录至终态。参数：mode=image|video ratio=9:16|16:9|3:4 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const mode = process.argv[2] ?? 'image'
const ratio = process.argv[3] ?? '9:16'
const topic = '关于人社局无人机装调检修工程师就业免费培训'
const evidence = (n) => join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04', n)
const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)

  // 1) 提示词：打开编辑器→填需求→读回→保存
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(800)
  const promptBox = page.locator('textarea[placeholder*="输入你的需求"]').first()
  if (await promptBox.isVisible({ timeout: 3000 }).catch(() => false)) {
    await promptBox.fill(topic)
    const readBack = await promptBox.inputValue().catch(() => '')
    console.log('PROMPT_READBACK=' + JSON.stringify(readBack))
    await page.getByText('保存', { exact: true }).first().click()
    await page.waitForTimeout(600)
    const promptSet = await page.locator('textarea[placeholder*="输入你的需求"]').first().inputValue().catch(() => '')
    console.log('PROMPT_AFTER_SAVE=' + JSON.stringify(promptSet))
  } else {
    console.log('PROMPT_BOX_NOT_FOUND')
  }

  // 2) 模式
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText(mode === 'video' ? '生成草稿(视频)' : '生成草稿(图文)', { exact: true }).last().click().catch(async () => {
    await page.getByText(mode === 'video' ? '生成草稿(视频)' : '生成草稿(图文)', { exact: true }).first().click()
  })
  await page.waitForTimeout(700)
  console.log('MODE_TEXT=' + await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().textContent().catch(() => ''))

  // 3) 平台：打开弹窗记录可选平台；勾选抖音；关闭
  await page.getByText(/\d+ 个平台/).first().click()
  await page.waitForTimeout(800)
  const modal = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popover"]')).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).join(' | '))
  console.log('PLATFORM_CHOICES=' + modal.slice(0, 300))
  for (const name of ['抖音', '小红书']) {
    const item = page.getByText(name, { exact: true }).last()
    if (await item.isVisible({ timeout: 1500 }).catch(() => false)) {
      await item.click({ force: true }).catch(() => {})
    }
  }
  await page.getByText('确定', { exact: true }).first().click().catch(async () => {
    await page.getByText('取消', { exact: true }).first().click().catch(() => {})
  })
  await page.waitForTimeout(800)

  // 4) 画幅 + 数量
  await page.locator('[data-testid="draftbox-ai-ratio"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText(ratio, { exact: true }).last().click().catch(async () => {
    await page.getByText(ratio, { exact: true }).first().click()
  })
  await page.waitForTimeout(500)
  console.log('RATIO_TEXT=' + await page.locator('[data-testid="draftbox-ai-ratio"]').first().textContent().catch(() => ''))

  // 5) 提交
  await page.screenshot({ path: evidence('real-before-submit-' + mode + '-' + ratio + '.png') }).catch(() => {})
  await page.locator('[data-testid="draftbox-ai-submit-btn"]').first().click()
  console.log('SUBMIT_CLICKED')
  await page.waitForTimeout(5000)
  await page.screenshot({ path: evidence('real-5s-' + mode + '-' + ratio + '.png') }).catch(() => {})

  // 6) 保持运行，观察生成记录（页面可见状态）
  await page.getByText('生成记录', { exact: true }).last().click().catch(() => {})
  for (let i = 0; i < 24; i += 1) {
    await page.waitForTimeout(15000)
    const text = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ').slice(-400)
    const done = /成功|失败|已生成|已完成|可查看|正在生成|生成中/.test(text || '')
    await page.screenshot({ path: evidence('real-poll-' + (i + 1) + '-' + mode + '-' + ratio + '.png') }).catch(() => {})
    console.log('POLL_' + (i + 1) + '=' + (text || '').slice(0, 200))
    if (done && i > 1) break
  }
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  await app.close().catch(() => {})
}
