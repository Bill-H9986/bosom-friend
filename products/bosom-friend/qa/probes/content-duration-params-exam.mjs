#!/usr/bin/env node
/**
 * 内容创作「视频时长」参数验收：每个档位点了要留得住，且下单用的就是界面上那一档。
 *
 * 现场（2026-09-19，DEF-112）：
 *   ① 点「30 秒」→ 药丸显示 30 秒，页面发出的生成请求却是 `"duration":5`（模型默认档）；
 *   ② 点 4 / 6 / 8 / 10 秒 → 药丸变成 12 秒（用户点的那一档留不住）。
 * 两个都是"界面与请求不是同一件事"，因此判据必须同时看**页面**与**页面自己的请求**：
 *
 *   A. 逐个档位回环：点哪一档，药丸就显示哪一档；
 *   B. 提交后，页面请求里的 duration 等于药丸上显示的那一档，且不是模型默认档。
 *
 * A 段不产生任何厂商调用；B 段会真出一条片（--seconds 决定档位，默认 30 秒）。
 *
 * Usage: node products/bosom-friend/qa/probes/content-duration-params-exam.mjs [--seconds 30] [--skip-run]
 * @module qa/probes/content-duration-params-exam
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'content-duration-params-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
const args = process.argv.slice(2)
const secondsIndex = args.indexOf('--seconds')
const SECONDS = secondsIndex >= 0 ? Number(args[secondsIndex + 1]) : 30
const SKIP_RUN = args.includes('--skip-run')
const EVENTS = join(EVIDENCE, 'events.jsonl')
const REPORT = join(EVIDENCE, 'REPORT.json')
writeFileSync(EVENTS, '')
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')
const PROMPT = '时长档位验收：干净背景上一只白色陶瓷杯，画面稳定，适合做贴片广告素材'
const GEARS = [{ label: '4 秒', seconds: 4 }, { label: '5 秒', seconds: 5 }, { label: '6 秒', seconds: 6 }, { label: '8 秒', seconds: 8 }, { label: '10 秒', seconds: 10 }, { label: '12 秒', seconds: 12 }, { label: '30 秒', seconds: 30 }, { label: '1 分钟', seconds: 60 }]
const SUMMARY = { startedAt: new Date().toISOString(), targetSeconds: SECONDS, status: 'running', roundTrip: [], pillText: '', pillSeconds: null, requestDuration: null, videoUrl: '', checks: [], pageErrors: [] }

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
/** 从"30 秒 / 1 分钟"这类文案里读秒数。 @param text - 文案。 @returns 秒数或 null。 */
function parseSeconds(text) {
  const minutes = /(\d+)\s*分钟/.exec(text)
  if (minutes) return Number(minutes[1]) * 60
  const seconds = /(\d+)\s*秒/.exec(text)
  return seconds ? Number(seconds[1]) : null
}

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--window-size=1500,1000', '--window-position=40,40', '--force-device-scale-factor=1'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => { SUMMARY.pageErrors.push(String(error)); record({ kind: 'PAGEERROR', text: String(error).slice(0, 300) }) })

const submits = []
page.on('response', async (response) => {
  if (response.request().method() !== 'POST') return
  if (!/ai\/draft-generation\/v2$/.test(new URL(response.url()).pathname)) return
  const request = response.request().postData() ?? ''
  submits.push(request)
  record({ kind: 'SUBMIT', text: '请求体=' + request.slice(0, 400) })
})

/** 截图。 @param name - 文件名。 */
async function shot(name) { await page.screenshot({ path: join(EVIDENCE, name + '.png') }).catch(() => {}) }
/** 读 testid 文本。 @param id - data-testid。 */
async function textOf(id) {
  const locator = page.locator('[data-testid="' + id + '"]').first()
  if (await locator.count() === 0) return ''
  return ((await locator.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
}

try {
  await page.goto(BASE + '#/draft-box', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(800)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(2000)

  // A 段：逐个档位回环（不产生厂商调用）
  const pill = page.locator('[data-testid="draftbox-ai-duration"]').first()
  for (const gear of GEARS) {
    await pill.click()
    await page.waitForTimeout(1200)
    // 只在**当前打开的弹层**里找档位按钮：页面别处也有"30 秒"这类文字（模型参数、耗时说明），
    // 用全页匹配会点到别的元素上，把"点不动"误判成"参数不生效"（实测 2026-09-19）。
    const popover = page.locator('[data-radix-popper-content-wrapper]').last()
    const option = popover.getByText(gear.label, { exact: true })
    if (await option.count() === 0) {
      SUMMARY.roundTrip.push({ ...gear, shown: null })
      check('档位「' + gear.label + '」在选择器里', false, '弹层里没有这个档位')
      await page.keyboard.press('Escape')
      continue
    }
    await option.last().click()
    await page.waitForTimeout(1500)
    const shown = parseSeconds(await textOf('draftbox-ai-duration'))
    SUMMARY.roundTrip.push({ ...gear, shown })
    check('点「' + gear.label + '」后药丸显示同一档', shown === gear.seconds, '药丸显示=' + String(shown) + ' 秒')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }
  await shot('01-档位回环完成')

  // 把档位停在目标档，准备提交
  const target = GEARS.find(gear => gear.seconds === SECONDS) ?? GEARS[6]
  await pill.click()
  await page.waitForTimeout(1200)
  await page.locator('[data-radix-popper-content-wrapper]').last().getByText(target.label, { exact: true }).last().click()
  await page.waitForTimeout(1500)
  SUMMARY.pillText = await textOf('draftbox-ai-duration')
  SUMMARY.pillSeconds = parseSeconds(SUMMARY.pillText)
  await shot('02-停在' + target.label)

  // 写提示词并提交
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(1000)
  const dialogInput = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  await dialogInput.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(PROMPT)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.locator('[data-testid="draftbox-ai-submit-btn"]').first().click()
  record({ kind: 'STEP', text: '已提交生成' })
  await page.waitForTimeout(8000)
  await shot('03-已提交')

  // B 段：页面自己发出的请求里，duration 必须是药丸上那一档
  const body = submits[0] ?? ''
  if (body !== '') {
    try { SUMMARY.requestDuration = Number(JSON.parse(body)?.duration ?? NaN) }
    catch { SUMMARY.requestDuration = null }
  }
  check('请求里的 duration 等于药丸显示的档位',
    SUMMARY.requestDuration !== null && SUMMARY.requestDuration === SUMMARY.pillSeconds,
    '药丸=' + String(SUMMARY.pillSeconds) + ' 秒，请求 duration=' + String(SUMMARY.requestDuration))
  check('请求里的 duration 不是模型默认档 5 秒', SUMMARY.requestDuration !== 5 || SECONDS === 5,
    '请求 duration=' + String(SUMMARY.requestDuration))

  if (!SKIP_RUN) {
    const startedAt = Date.now()
    let lastText = ''
    for (;;) {
      await page.waitForTimeout(20_000)
      const minutes = Math.round((Date.now() - startedAt) / 60_000)
      const bodyText = ((await page.locator('body').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
      const match = /(生成中|已完成|生成失败|部分成功|成功|失败)/.exec(bodyText.slice(0, 8000))
      const stateText = match ? match[0] : ''
      if (stateText !== lastText) { lastText = stateText; record({ kind: 'PROGRESS', minutes, text: '页面状态词=' + stateText }) }
      // 终态判据用**记录卡上的状态词**：内容创作页把结果渲染成卡片（成功/失败/生成中），
      // 不是 <video> 播放器——按 video 元素找会一直等不到，把"已经出片"误判成超时（实测 2026-09-19）。
      const successCard = page.getByText('生成成功', { exact: true })
      if (await successCard.count() > 0) {
        SUMMARY.videoVisible = true
        record({ kind: 'VIDEO', text: '页面出现「生成成功」记录卡，共 ' + String(await successCard.count()) + ' 张' })
        await shot('99-页面成片')
        break
      }
      if (minutes >= 45) { record({ kind: 'TIMEOUT', text: '45 分钟未见成片' }); await shot('99-超时'); break }
      if (minutes > 0 && minutes % 5 === 0) await shot('progress-' + String(minutes).padStart(3, '0') + 'm')
    }
  }
  SUMMARY.status = SUMMARY.checks.every(item => item.ok) ? 'passed' : 'failed'
} catch (error) {
  SUMMARY.status = 'error'
  SUMMARY.error = String(error).slice(0, 800)
  record({ kind: 'ERROR', text: SUMMARY.error.slice(0, 400) })
  await shot('99-异常')
} finally {
  SUMMARY.finishedAt = new Date().toISOString()
  writeFileSync(REPORT, JSON.stringify(SUMMARY, null, 2), 'utf8')
  await page.waitForTimeout(5000)
  await browser.close().catch(() => {})
  const failed = SUMMARY.checks.filter(item => !item.ok)
  console.log('CONTENT_DURATION_PARAMS ' + (SUMMARY.status === 'passed' ? 'PASS' : 'FAIL') + ' checks=' + String(SUMMARY.checks.length) + ' fail=' + String(failed.length))
  console.log('EVIDENCE=' + EVIDENCE)
  process.exit(SUMMARY.status === 'passed' ? 0 : 1)
}
