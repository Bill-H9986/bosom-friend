#!/usr/bin/env node
/**
 * 清掉本轮参数验收在「生成记录」里留下的记录（只删带验收标记的那些，不碰用户自己的记录）。
 *
 * 规矩（EXAM_PROTOCOL 第 4 节）：测试数据的清理**只能通过前端页面完成**。
 * 因此这条脚本走的是页面自身的「生成记录」面板 → 每条记录的删除按钮 → 确认框。
 *
 * 判据：删完后面板上不再有带标记的记录；刷新页面后仍然没有（不是乐观移除）。
 *
 * Usage: node products/bosom-friend/qa/probes/cleanup-acceptance-records.mjs [--dry]
 * @module qa/probes/cleanup-acceptance-records
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'cleanup-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
const EVENTS = join(EVIDENCE, 'events.jsonl')
const REPORT = join(EVIDENCE, 'REPORT.json')
writeFileSync(EVENTS, '')
const DRY = process.argv.includes('--dry')
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')
/** 本轮验收写进记录的提示词标记：只有带这些字样的记录才删。 */
const MARKERS = ['逐档验收', '参数写入请求验收', '时长档位验收', '素材时长口径回归', '档位口径回归', '端到端验收用的竖屏画面']
const SUMMARY = { startedAt: new Date().toISOString(), status: 'running', dry: DRY, deleted: [], remaining: [], checks: [] }

/** 记录一条事件。 @param event - 事件对象。 */
function record(event) {
  const line = { at: new Date().toISOString(), ...event }
  appendFileSync(EVENTS, JSON.stringify(line) + '\n', 'utf8')
  console.log('[' + line.at.slice(11, 19) + '] ' + String(line.kind ?? '') + ' ' + String(line.text ?? ''))
}
/** 追加一条判定。 @param name - 判据名。 @param ok - 是否成立。 @param detail - 现场描述。 */
function check(name, ok, detail) {
  SUMMARY.checks.push({ name, ok, detail })
  record({ kind: ok ? 'PASS' : 'FAIL', text: name + '：' + detail })
}

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--window-size=1500,1000', '--window-position=40,40', '--force-device-scale-factor=1'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

/** 打开「生成记录」面板。 */
async function openPanel() {
  const button = page.locator('button:visible').filter({ hasText: '生成记录' }).first()
  await button.click()
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="draftbox-generation-detail-dialog"]').first().waitFor({ state: 'visible', timeout: 30_000 })
}
/** 列出面板里带标记的记录（按删除按钮定位，往上找包含标记的那一行）。 @returns 待删条目的描述。 */
async function listMarked() {
  return await page.evaluate((markers) => {
    const dialog = document.querySelector('[data-testid="draftbox-generation-detail-dialog"]')
    if (dialog === null) return []
    const buttons = Array.from(dialog.querySelectorAll('button[aria-label="删除生成记录"]'))
    const out = []
    buttons.forEach((button, index) => {
      let node = button
      for (let depth = 0; depth < 8 && node.parentElement !== null; depth += 1) {
        node = node.parentElement
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (markers.some(marker => text.includes(marker))) { out.push({ index, text: text.slice(0, 90) }); return }
        if (text.length > 400) break
      }
    })
    return out
  }, MARKERS)
}

try {
  await page.goto(BASE + '#/draft-box', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(4000)
  await openPanel()
  await page.screenshot({ path: join(EVIDENCE, '01-记录面板.png') }).catch(() => {})

  let guard = 0
  for (;;) {
    const marked = await listMarked()
    if (marked.length === 0) break
    if (guard++ > 40) { record({ kind: 'STOP', text: '删除循环超过 40 次，停手' }); break }
    record({ kind: 'MARKED', text: '待删 ' + String(marked.length) + ' 条，例如：' + marked[0].text })
    if (DRY) { SUMMARY.deleted.push(...marked.map(item => item.text)); break }
    const dialog = page.locator('[data-testid="draftbox-generation-detail-dialog"]').first()
    const buttons = dialog.locator('button[aria-label="删除生成记录"]')
    // 每次都重新定位并删**第一条带标记的**：删完面板会重排，索引会变。
    const index = marked[0].index
    await buttons.nth(index).click()
    await page.waitForTimeout(1200)
    const confirm = page.locator('[role="alertdialog"] button, [role="dialog"] button').filter({ hasText: /确定|删除|确认/ }).last()
    await confirm.click().catch(async () => { await page.keyboard.press('Enter') })
    await page.waitForTimeout(2500)
    SUMMARY.deleted.push(marked[0].text)
    record({ kind: 'DELETED', text: marked[0].text })
  }

  // 刷新后再看一遍：乐观移除会"回魂"，真实删除不会。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().waitFor({ state: 'visible', timeout: 120_000 })
  await page.waitForTimeout(5000)
  await openPanel()
  const remaining = await listMarked()
  SUMMARY.remaining = remaining
  await page.screenshot({ path: join(EVIDENCE, '02-刷新后.png') }).catch(() => {})
  check('刷新后带标记的验收记录已清零', remaining.length === 0, '剩余 ' + String(remaining.length) + ' 条' + (remaining.length > 0 ? '：' + remaining[0].text : ''))
  SUMMARY.status = SUMMARY.checks.every(item => item.ok) ? 'passed' : 'failed'
} catch (error) {
  SUMMARY.status = 'error'
  SUMMARY.error = String(error).slice(0, 800)
  record({ kind: 'ERROR', text: SUMMARY.error.slice(0, 400) })
  await page.screenshot({ path: join(EVIDENCE, '99-异常.png') }).catch(() => {})
} finally {
  SUMMARY.finishedAt = new Date().toISOString()
  writeFileSync(REPORT, JSON.stringify(SUMMARY, null, 2), 'utf8')
  await page.waitForTimeout(3000)
  await browser.close().catch(() => {})
  console.log('CLEANUP ' + (SUMMARY.status === 'passed' ? 'PASS' : 'FAIL') + ' deleted=' + String(SUMMARY.deleted.length) + ' remaining=' + String(SUMMARY.remaining.length))
  process.exit(SUMMARY.status === 'passed' ? 0 : 1)
}
