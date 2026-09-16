#!/usr/bin/env node
/**
 * 视频时长复测：真实前端提交 5/10/15/30/60/120/180 秒，
 * 保持窗口并轮询生成记录；完成后截图，并把成品文件复制到证据目录。
 * 页面操作是产品验收证据；文件探测仅用于核对实际时长/尺寸。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
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

const evidenceDir = join(repoRoot, 'products/bosom-friend/qa/evidence/duration-retest')
mkdirSync(evidenceDir, { recursive: true })
const topic = '关于人社局无人机装调检修工程师就业免费培训'
const dataFile = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend', 'draft-generations.json')
const durations = [5, 10, 15, 30, 60, 120, 180]
const labels = {
  5: '5 秒',
  10: '10 秒',
  15: '15 秒',
  30: '30 秒',
  60: '1 分钟',
  120: '2 分钟',
  180: '3 分钟',
}
const submitted = []

const app = await electron.launch({
  executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe',
})
try {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await page.getByText('内容创作', { exact: true }).first().click()
  await page.waitForTimeout(2500)

  page.on('response', async (res) => {
    if (res.request().method() === 'POST' && /ai\/draft-generation\/v2/.test(res.url())) {
      const body = await res.json().catch(() => ({}))
      submitted.push(...(body?.data?.taskIds ?? []))
      console.log('TASK_CREATE body=' + JSON.stringify(body).slice(0, 240))
    }
  })

  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(900)
  const dialogInput = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  await dialogInput.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(topic)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(800)
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(1000)

  const durationBtn = page.locator('[data-testid="draftbox-ai-duration"]').first()
  const submitBtn = page.locator('[data-testid="draftbox-ai-submit-btn"]').first()
  for (const seconds of durations) {
    await durationBtn.click()
    await page.waitForTimeout(900)
    await page.getByText(labels[seconds], { exact: true }).last().click().catch(async () => {
      await page.getByText(labels[seconds], { exact: true }).first().click()
    })
    await page.waitForTimeout(600)
    const label = ((await durationBtn.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
    console.log('SET ' + seconds + 's -> ' + label)
    await submitBtn.click()
    await page.waitForTimeout(2200)
  }
  console.log('SUBMITTED=' + submitted.join(','))

  await page.getByText('生成记录', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(evidenceDir, 'generation-detail-after-submit.png') }).catch(() => {})

  let lastStatus = ''
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(10000)
    let lines = []
    try {
      const rows = JSON.parse(readFileSync(dataFile, 'utf8')).value ?? []
      lines = submitted.map((id) => {
        const row = rows.find((item) => item.id === id)
        return row ? `${id}:${row.status}:${row.response?.videoUrl ?? ''}` : `${id}:missing`
      })
    } catch {
      // 文件可能正在原子写入；不影响页面观察
    }
    lastStatus = lines.join(' | ')
    console.log('POLL ' + (i + 1) + ' ' + lastStatus)
    const done = lines.every((line) => /success|failed|partial/.test(line))
    if (done) break
  }
  await page.screenshot({ path: join(evidenceDir, 'generation-detail-final.png') }).catch(() => {})
  console.log('FINAL=' + lastStatus)

  // 复制实际产物（诊断证据），不写入产品数据
  try {
    const rows = JSON.parse(readFileSync(dataFile, 'utf8')).value ?? []
    for (const id of submitted) {
      const row = rows.find((item) => item.id === id)
      const url = row?.response?.videoUrl ?? ''
      const name = basename(url)
      const src = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend', 'uploads', name)
      if (url && existsSync(src)) {
        const dest = join(evidenceDir, `${id}-${name}`)
        copyFileSync(src, dest)
      }
    }
  } catch (error) {
    console.log('COPY_FAIL=' + String(error))
  }
} finally {
  try {
    const w = app.windows()[0]
    if (w) await w.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
  } catch {}
  try { await app.close().catch(() => {}) } catch {}
}
