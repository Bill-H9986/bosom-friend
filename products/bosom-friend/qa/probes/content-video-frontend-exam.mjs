#!/usr/bin/env node
/**
 * 内容创作「视频档位」真实前端验收：在真实产品页面上选档位、点生成，盯到终态，
 * 把页面上的状态/成片与成片文件的真实规格归档。
 *
 * 与 qa/probes/verify-composed-30s.mjs 的分工：那条用假厂商验的是拆分/拼接/预算的状态机；
 * 这条用真实厂商验的是"用户在界面上选 30 秒/1 分钟，最后真的拿到那么长的成片"。
 *
 * 只做两件被允许的事：点真实控件、读页面可见文本与截图。
 * 成片文件只用 ffmpeg 读元数据（诊断证据），不作为 PASS 判据。
 *
 * Usage: node products/bosom-friend/qa/probes/content-video-frontend-exam.mjs --seconds 30 [--label 30秒]
 * @module qa/probes/content-video-frontend-exam
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'content-video-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')
const args = process.argv.slice(2)
const secondsIndex = args.indexOf('--seconds')
const SECONDS = secondsIndex >= 0 ? Number(args[secondsIndex + 1]) : 30
const labelIndex = args.indexOf('--label')
const LABEL = labelIndex >= 0 ? String(args[labelIndex + 1]) : (SECONDS >= 60 ? '1 分钟' : String(SECONDS) + ' 秒')
const EVENTS = join(EVIDENCE, 'events-' + String(SECONDS) + 's.jsonl')
const REPORT = join(EVIDENCE, 'report-' + String(SECONDS) + 's.json')
writeFileSync(EVENTS, '')
const PROMPT = '端到端验收用的竖屏画面：' + LABEL + '档位，干净背景上一只白色陶瓷杯，画面稳定，适合做贴片广告素材'
const SUMMARY = { startedAt: new Date().toISOString(), seconds: SECONDS, label: LABEL, status: 'running', pageErrors: [], durationLabel: '', displayedDuration: null, requestDuration: null, paramMatch: null, submitResponse: '', submitRequest: '', recordStatusText: '', videoUrl: '', videoFile: '', ffprobe: '', minutes: 0 }

/** 记录一条事件。 @param event - 事件对象。 */
function record(event) {
  const line = { at: new Date().toISOString(), ...event }
  appendFileSync(EVENTS, JSON.stringify(line) + '\n', 'utf8')
  console.log('[' + line.at.slice(11, 19) + '] ' + String(line.kind ?? '') + ' ' + String(line.text ?? ''))
}

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--window-size=1500,1000', '--window-position=40,40', '--force-device-scale-factor=1'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => { SUMMARY.pageErrors.push(String(error)); record({ kind: 'PAGEERROR', text: String(error).slice(0, 300) }) })
/**
 * 从页面上的时长药丸文案里读秒数。
 *
 * 这是"用户看到的档位"，用来和页面自己发出的请求体对账（DEF-112）：
 * 只看请求、或只看界面，都会漏掉"界面 30 秒、请求 5 秒"这种两边各自都对的形态。
 * @param text - 药丸文案，例如 "30 秒" 或 "1 分钟"。
 * @returns 秒数；读不出来时返回 null。
 */
function parseDurationLabel(text) {
  const minutes = /(\d+)\s*分钟/.exec(text)
  if (minutes) return Number(minutes[1]) * 60
  const seconds = /(\d+)\s*秒/.exec(text)
  if (seconds) return Number(seconds[1])
  return null
}

const posts = []
page.on('response', async response => {
  if (response.request().method() !== 'POST') return
  const url = response.url()
  if (!/ai\/draft-generation/.test(url)) return
  const body = await response.text().catch(() => '')
  // 请求体是"参数有没有真的写进去"的唯一判据：页面发的什么，服务端就收到什么。
  const requestBody = response.request().postData() ?? ''
  const row = { url: url.replace(BASE, ''), status: response.status(), body: body.slice(0, 400), request: requestBody.slice(0, 600) }
  posts.push(row)
  if (/\/v2$|\/ai\/draft-generation$/.test(new URL(url).pathname)) {
    SUMMARY.submitResponse = JSON.stringify({ url: row.url, status: row.status, body: row.body }).slice(0, 500)
    SUMMARY.submitRequest = row.request
    record({ kind: 'SUBMIT', text: row.url + ' 请求体=' + row.request.slice(0, 300) })
  }
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
  await page.waitForTimeout(2000)
  record({ kind: 'STEP', text: '草稿箱已打开' })

  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(1200)
  const dialogInput = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  await dialogInput.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(PROMPT)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(1200)

  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(800)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(1500)

  const durationBtn = page.locator('[data-testid="draftbox-ai-duration"]').first()
  await durationBtn.click()
  await page.waitForTimeout(1200)
  const option = page.getByText(LABEL, { exact: true })
  const optionCount = await option.count()
  record({ kind: 'POPOVER', text: '档位「' + LABEL + '」在弹层里的匹配数=' + String(optionCount) })
  if (optionCount === 0) throw new Error('弹层里没有档位 ' + LABEL)
  await option.last().click()
  await page.waitForTimeout(1200)
  SUMMARY.durationLabel = ((await durationBtn.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
  record({ kind: 'DURATION', text: '选中后按钮文案=' + SUMMARY.durationLabel })
  await shot('01-选中' + LABEL + '档位')

  const startedAt = Date.now()
  await page.locator('[data-testid="draftbox-ai-submit-btn"]').first().click()
  record({ kind: 'START', text: '已提交生成' })
  await page.waitForTimeout(6000)
  await shot('02-已提交')

  // 界面档位 vs 页面自己发出的请求体（DEF-112 的回归断言）。
  // 只断言"页面显示 30 秒"是假绿：真正的口径是**下单用哪个时长**。
  SUMMARY.displayedDuration = parseDurationLabel(SUMMARY.durationLabel)
  const requestRow = posts.find(item => /\/v2$|\/ai\/draft-generation$/.test(new URL(item.url, BASE).pathname))
  if (requestRow !== undefined && requestRow.request !== '') {
    try {
      const parsed = JSON.parse(requestRow.request)
      SUMMARY.requestDuration = typeof parsed?.duration === 'number' ? parsed.duration : null
    }
    catch { record({ kind: 'PARSE_FAIL', text: '请求体不是 JSON：' + requestRow.request.slice(0, 200) }) }
  }
  SUMMARY.paramMatch = SUMMARY.displayedDuration !== null && SUMMARY.requestDuration !== null
    ? SUMMARY.displayedDuration === SUMMARY.requestDuration
    : null
  record({
    kind: 'PARAM_CHECK',
    text: '界面档位=' + String(SUMMARY.displayedDuration) + ' 秒，页面请求 duration=' + String(SUMMARY.requestDuration)
      + '，一致=' + String(SUMMARY.paramMatch),
  })
  if (SUMMARY.paramMatch === false)
    throw new Error('界面显示的档位与页面实际提交的时长不一致：界面 ' + String(SUMMARY.displayedDuration) + ' 秒，请求 ' + String(SUMMARY.requestDuration) + ' 秒（DEF-112）')

  let lastText = ''
  for (;;) {
    await page.waitForTimeout(30_000)
    const minutes = Math.round((Date.now() - startedAt) / 60_000)
    const bodyText = ((await page.locator('body').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const match = /(生成中|已完成|生成失败|部分成功|成功|失败)/.exec(bodyText.slice(0, 6000))
    const stateText = match ? match[0] : ''
    if (stateText !== lastText) { lastText = stateText; record({ kind: 'PROGRESS', minutes, text: '页面状态词=' + stateText }) }
    const videoCount = await page.locator('video').count()
    if (videoCount > 0) {
      const src = await page.locator('video').first().getAttribute('src').catch(() => '') ?? ''
      if (src !== '') {
        SUMMARY.videoUrl = src
        SUMMARY.status = 'video-visible'
        SUMMARY.minutes = minutes
        record({ kind: 'VIDEO', text: '页面出现成片播放器 src=' + src })
        await shot('99-页面成片')
        break
      }
    }
    const failures = await page.getByText(/生成失败|部分成功|超时|失败/).count()
    if (failures > 0 && minutes >= 3) {
      const failText = ((await page.getByText(/生成失败|部分成功|超时|失败/).first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')
      SUMMARY.status = 'failed'
      SUMMARY.recordStatusText = failText
      SUMMARY.minutes = minutes
      record({ kind: 'FAILED', text: failText.slice(0, 300) })
      await shot('99-失败态')
      break
    }
    if (minutes >= 45) { SUMMARY.status = 'timeout'; await shot('99-超时'); break }
    if (minutes % 3 === 0) await shot('progress-' + String(minutes).padStart(3, '0') + 'm')
  }

  // 成片规格：只看文件元数据
  const fileName = SUMMARY.videoUrl.split('/').pop() ?? ''
  const filePath = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend', 'uploads', fileName)
  SUMMARY.videoFile = filePath
  SUMMARY.videoExists = fileName !== '' && existsSync(filePath)
  if (SUMMARY.videoExists) {
    const probe = spawnSync(join(PRODUCT, 'desktop', 'dist', 'runtime', 'ffmpeg.exe'), ['-hide_banner', '-i', filePath], { encoding: 'utf8' })
    SUMMARY.ffprobe = String(probe.stderr ?? '').split('\n').filter(line => /Duration|Stream #/.test(line)).join(' | ').trim()
    record({ kind: 'FFPROBE', text: SUMMARY.ffprobe })
  }
  SUMMARY.finishedAt = new Date().toISOString()
} catch (error) {
  SUMMARY.status = 'error'
  SUMMARY.error = String(error).slice(0, 800)
  record({ kind: 'ERROR', text: SUMMARY.error.slice(0, 300) })
  await shot('99-异常')
} finally {
  writeFileSync(REPORT, JSON.stringify(SUMMARY, null, 2), 'utf8')
  await page.waitForTimeout(8000)
  await browser.close().catch(() => {})
  console.log('EVIDENCE=' + EVIDENCE)
  console.log('SUMMARY=' + JSON.stringify({ status: SUMMARY.status, durationLabel: SUMMARY.durationLabel, ffprobe: SUMMARY.ffprobe, minutes: SUMMARY.minutes }))
}
