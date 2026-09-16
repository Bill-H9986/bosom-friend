#!/usr/bin/env node
/**
 * 视频全时长矩阵：通过真实前端逐档提交 5/10/15/30/60/120/180 秒，
 * 记录页面发起的创建请求与生成记录可见文本，最后截图留证。
 * 只操作页面；不直接调用后端、不写产品数据。
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(
  repoRoot,
  'node_modules',
  '.pnpm',
  'playwright@1.61.1',
  'node_modules',
  'playwright',
  'test',
))

const evidenceDir = join(repoRoot, 'products/bosom-friend/qa/evidence/duration-matrix')
mkdirSync(evidenceDir, { recursive: true })
const topic = '关于人社局无人机装调检修工程师就业免费培训'
const durations = [
  { seconds: 5, label: '5 秒' },
  { seconds: 10, label: '10 秒' },
  { seconds: 15, label: '15 秒' },
  { seconds: 30, label: '30 秒' },
  { seconds: 60, label: '1 分钟' },
  { seconds: 120, label: '2 分钟' },
  { seconds: 180, label: '3 分钟' },
]
const created = []

const app = await electron.launch({
  executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe',
})
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)

  page.on('response', async (res) => {
    const url = res.url()
    if (res.request().method() === 'POST' && /ai\/draft-generation\/v2/.test(url)) {
      let body = ''
      try {
        body = JSON.stringify(await res.json().catch(() => ({}))).slice(0, 600)
      } catch {}
      created.push({ url, status: res.status(), body })
      console.log('CREATE_POST status=' + res.status() + ' url=' + url)
      console.log('CREATE_BODY=' + body)
    }
  })

  // 提示词：用真实编辑器保存并读回
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(900)
  const dialogInput = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  await dialogInput.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(topic)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(800)

  // 视频模式
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(1000)
  console.log('MODEL=' + (await page.locator('[data-testid="draftbox-ai-model"]').first().textContent().catch(() => '')))

  const durationBtn = page.locator('[data-testid="draftbox-ai-duration"]').first()
  const submitBtn = page.locator('[data-testid="draftbox-ai-submit-btn"]').first()

  for (const item of durations) {
    await durationBtn.click()
    await page.waitForTimeout(900)
    await page.getByText(item.label, { exact: true }).last().click().catch(async () => {
      await page.getByText(item.label, { exact: true }).first().click()
    })
    await page.waitForTimeout(700)
    const label = ((await durationBtn.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
    console.log('DURATION_SET seconds=' + item.seconds + ' visible=' + label)
    await page.screenshot({ path: join(evidenceDir, 'before-' + item.seconds + 's.png') }).catch(() => {})
    await submitBtn.click()
    console.log('SUBMIT seconds=' + item.seconds)
    await page.waitForTimeout(2500)
  }

  console.log('CREATE_COUNT=' + created.length)
  await page.screenshot({ path: join(evidenceDir, 'after-all-submits.png') }).catch(() => {})

  // 打开生成任务详情
  await page.getByText('生成记录', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(3000)
  let bodyText = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ') ?? ''
  console.log('GENERATION_DETAIL_TAIL=' + bodyText.slice(-900))
  await page.screenshot({ path: join(evidenceDir, 'generation-detail.png') }).catch(() => {})

  // 保持运行，持续观察页面里的终态；外部可另查产物文件
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(15000)
    bodyText = (await page.textContent('body').catch(() => ''))?.replace(/\s+/g, ' ') ?? ''
    const hasTerminal = /生成成功|生成失败|部分成功/.test(bodyText)
    console.log('POLL ' + (i + 1) + ' terminal=' + hasTerminal + ' tail=' + bodyText.slice(-300))
    await page.screenshot({ path: join(evidenceDir, 'poll-' + (i + 1) + '.png') }).catch(() => {})
    if (hasTerminal && !/生成中|正在生成/.test(bodyText)) break
  }
  console.log('MATRIX_EVIDENCE=' + evidenceDir)
} finally {
  if (process.env.KEEP_ALIVE !== '1') {
    try {
      const w = app.windows()[0]
      if (w) await w.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
      await new Promise((r) => setTimeout(r, 1200))
    } catch {}
    try { await app.close().catch(() => {}) } catch {}
  }
}
