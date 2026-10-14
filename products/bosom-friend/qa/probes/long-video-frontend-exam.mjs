#!/usr/bin/env node
/**
 * 长视频真实全流程验收（前端驱动）：在真实产品页面上建一条数字人口播长视频，
 * 盯到终态，把页面可见进度、分镜、成片与截图全部归档。
 *
 * 只做三件被允许的事：打开页面、点真实控件、读页面可见文本与截图。
 * 不调用产品业务接口、不读写产品数据文件；ffmpeg 只读成片文件的元数据（诊断用）。
 *
 * Usage: node products/bosom-friend/qa/probes/long-video-frontend-exam.mjs [--seconds 90] [--keep]
 * @module qa/probes/long-video-frontend-exam
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const args = process.argv.slice(2)
// 每次跑用自己的证据目录（--tag），免得两次实验的事件流与截图互相覆盖。
const runTagArg = args.indexOf('--tag')
const RUN_TAG = runTagArg >= 0 ? String(args[runTagArg + 1]) : '2026-09-19'
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'long-video-' + RUN_TAG)
mkdirSync(EVIDENCE, { recursive: true })
const EVENTS = join(EVIDENCE, 'events.jsonl')
const REPORT = join(EVIDENCE, 'REPORT.json')
writeFileSync(EVENTS, '')
const secondsArg = args.indexOf('--seconds')
const SECONDS = secondsArg >= 0 ? Number(args[secondsArg + 1]) : 90
const KEEP = args.includes('--keep')
/** 只验到"点开始生成"之前为止：用于核对选择器与前置提示，不下单、不花额度。 */
const DRY = args.includes('--dry')
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')
/**
 * 卖点正文：默认是面霜那条老用例，用 `--topic-file <path>` 换成别的宣传内容。
 *
 * 走文件而不是命令行参数：中文长文本经 PowerShell 传参会被编码折腾，写进 UTF-8 文件最稳。
 */
const topicFileArg = args.indexOf('--topic-file')
const TOPIC = topicFileArg >= 0
  ? readFileSync(String(args[topicFileArg + 1]), 'utf8').trim()
  : '秋冬保湿面霜，主打干皮救急，成分温和不刺激，敏感肌也能用。今天直播间下单直降一百，前一百名送同款小样三件套，点下方小黄车就能拍。'
const SUMMARY = { startedAt: new Date().toISOString(), seconds: SECONDS, steps: [], status: 'running', taskId: '', pageErrors: [], scriptNeed: '', estimate: '', scriptChars: null, produced: '', videoUrl: '', shotsReady: null, shotsTotal: null, ffprobe: '' }

/** 追加一条事件，同时打印。 @param event - 事件对象。 */
function record(event) {
  const line = { at: new Date().toISOString(), ...event }
  appendFileSync(EVENTS, JSON.stringify(line) + '\n', 'utf8')
  console.log('[' + line.at.slice(11, 19) + '] ' + (line.kind ?? '') + ' ' + (line.text ?? JSON.stringify(line)))
}

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--window-size=1500,1000', '--window-position=40,40', '--force-device-scale-factor=1'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', error => { SUMMARY.pageErrors.push(String(error)); record({ kind: 'PAGEERROR', text: String(error).slice(0, 300) }) })
page.on('requestfailed', request => {
  const url = request.url()
  if (!/\.(mp4|webm|png|jpg|jpeg|woff2?)($|\?)/.test(url)) record({ kind: 'REQFAIL', text: request.method() + ' ' + url.slice(0, 160) + ' ' + String(request.failure()?.errorText ?? '') })
})

/** 截图归档。 @param name - 文件名。 */
async function shot(name) {
  const path = join(EVIDENCE, name + '.png')
  await page.screenshot({ path, fullPage: false }).catch(error => record({ kind: 'SHOTERR', text: String(error).slice(0, 200) }))
  return path
}

/** 读某个 testid 的可见文本。 @param id - data-testid。 @returns 文本。 */
async function textOf(id) {
  const locator = page.locator('[data-testid="' + id + '"]').first()
  if (await locator.count() === 0) return ''
  return ((await locator.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
}

try {
  await page.goto(BASE + '#/long-video', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="long-video-start"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(2500)
  record({ kind: 'STEP', text: '长视频页已打开' })
  await shot('01-长视频页-打开')

  // 门槛前置提示（DEF-108）：点时长之前页面就该告诉用户要多少字
  await page.locator('[data-testid="long-video-duration-' + String(SECONDS) + '"]').first().click()
  await page.waitForTimeout(2500)
  SUMMARY.scriptNeed = await textOf('long-video-script-need')
  for (let attempt = 0; attempt < 10 && SUMMARY.estimate === ''; attempt += 1) {
    await page.waitForTimeout(1000)
    SUMMARY.estimate = await textOf('long-video-estimate')
  }
  record({ kind: 'NEED', text: '门槛提示：' + SUMMARY.scriptNeed })
  record({ kind: 'ESTIMATE', text: '预估：' + SUMMARY.estimate })
  await shot('02-目标时长与字数门槛')

  // 内容形式：数字人口播
  const producer = page.locator('[data-testid="long-video-producer-digital-human"]').first()
  if (await producer.count() > 0) { await producer.click(); await page.waitForTimeout(1200) }
  const human = page.locator('[data-testid^="long-video-human-"]').first()
  if (await human.count() > 0) {
    const humanId = (await human.getAttribute('data-testid')) ?? ''
    await human.click()
    await page.waitForTimeout(1200)
    record({ kind: 'HUMAN', text: '选中数字人 ' + humanId.replace('long-video-human-', '') })
  }
  else record({ kind: 'HUMAN', text: '没有数字人可选，保持当前内容形式' })

  await page.locator('[data-testid="long-video-topic"]').first().fill(TOPIC)
  await page.waitForTimeout(600)
  const ratio = page.locator('[data-testid="long-video-ratio-9-16"]').first()
  if (await ratio.count() > 0) { await ratio.click(); await page.waitForTimeout(500) }
  const subs = page.locator('[data-testid="long-video-subtitles"]').first()
  if (await subs.count() > 0) {
    const checked = await subs.getAttribute('data-state').catch(() => null)
    if (checked !== 'checked') { await subs.click(); await page.waitForTimeout(500) }
  }
  record({ kind: 'FORM', text: '表单已填：目标 ' + String(SECONDS) + ' 秒 / 9:16 / 烧字幕 / 卖点 ' + String(TOPIC.length) + ' 字｜' + TOPIC.slice(0, 40) + '…' })
  await shot('03-表单填写完成')

  if (DRY) {
    SUMMARY.status = 'dry'
    SUMMARY.startText = await textOf('long-video-start')
    SUMMARY.duration = await page.locator('[data-testid="long-video-duration-' + String(SECONDS) + '"]').first().getAttribute('data-state').catch(() => null)
    record({ kind: 'DRY', text: 'dry-run 停在提交前：按钮=' + SUMMARY.startText })
    writeFileSync(REPORT, JSON.stringify(SUMMARY, null, 2), 'utf8')
    await page.waitForTimeout(2000)
    await browser.close().catch(() => {})
    console.log('EVIDENCE=' + EVIDENCE)
    process.exit(0)
  }

  const startedAt = Date.now()
  await page.locator('[data-testid="long-video-start"]').first().click()
  record({ kind: 'START', text: '已点击「开始生成」' })
  await page.waitForTimeout(4000)
  await shot('04-已提交-写稿阶段')

  let lastKey = ''
  let lastShot = 0
  let index = 0
  for (;;) {
    await page.waitForTimeout(30_000)
    index += 1
    const phase = await textOf('long-video-phase')
    const count = await textOf('long-video-progress-count')
    const chars = await textOf('long-video-script-chars')
    const produced = await textOf('long-video-produced')
    const errorText = await textOf('long-video-error')
    const result = await textOf('long-video-result')
    const elapsedMin = Math.round((Date.now() - startedAt) / 60_000)
    const key = [phase, count, chars, produced, errorText].join('|')
    if (key !== lastKey) {
      lastKey = key
      record({ kind: 'PROGRESS', minutes: elapsedMin, text: phase + ' | ' + count + ' | ' + chars + ' | ' + produced + (errorText ? ' | 错误=' + errorText : '') })
    }
    if (index % 6 === 0) await shot('progress-' + String(elapsedMin).padStart(3, '0') + 'm')

    const shots = page.locator('[data-testid="long-video-shots"] li')
    const shotsTotal = await shots.count()
    const shotsReady = await page.locator('[data-testid="long-video-shots"] li').filter({ hasText: '已生成' }).count().catch(() => -1)
    SUMMARY.shotsTotal = shotsTotal
    SUMMARY.shotsReady = shotsReady

    if (result !== '' || errorText !== '') {
      SUMMARY.status = errorText !== '' ? 'failed' : 'success'
      SUMMARY.produced = produced
      SUMMARY.scriptChars = chars
      SUMMARY.videoUrl = await page.locator('[data-testid="long-video-result"] video').first().getAttribute('src').catch(() => '') ?? ''
      SUMMARY.errorText = errorText
      await shot('99-终态')
      break
    }
    if ((Date.now() - startedAt) > 100 * 60_000) { SUMMARY.status = 'timeout'; await shot('99-超时'); break }
    void lastShot
  }

  // 分镜清单（页面上真实渲染的每一镜）
  const shotRows = []
  const items = page.locator('[data-testid="long-video-shots"] li')
  const total = await items.count()
  for (let i = 0; i < total; i += 1) shotRows.push(((await items.nth(i).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 120))
  SUMMARY.shots = shotRows
  SUMMARY.finishedAt = new Date().toISOString()
  SUMMARY.minutes = Math.round((Date.now() - startedAt) / 60_000)

  // 成片规格（诊断）：ffmpeg 只读文件元数据
  const videoSrc = SUMMARY.videoUrl || ''
  const fileName = videoSrc.split('/').pop() ?? ''
  const filePath = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend', 'uploads', fileName)
  SUMMARY.videoFile = filePath
  SUMMARY.videoExists = fileName !== '' && existsSync(filePath)
  if (SUMMARY.videoExists) {
    const ffprobe = join(PRODUCT, 'desktop', 'dist', 'runtime', 'ffmpeg.exe')
    const probe = spawnSync(ffprobe, ['-hide_banner', '-i', filePath], { encoding: 'utf8' })
    const text = String(probe.stderr ?? '')
    SUMMARY.ffprobe = text.split('\n').filter(line => /Duration|Stream #/.test(line)).join(' | ').trim()
    record({ kind: 'FFPROBE', text: SUMMARY.ffprobe })
  }
  writeFileSync(REPORT, JSON.stringify(SUMMARY, null, 2), 'utf8')
  record({ kind: 'DONE', text: 'status=' + SUMMARY.status + ' minutes=' + String(SUMMARY.minutes ?? '') + ' shots=' + String(SUMMARY.shotsReady) + '/' + String(SUMMARY.shotsTotal) })
} catch (error) {
  SUMMARY.status = 'error'
  SUMMARY.error = String(error).slice(0, 1000)
  record({ kind: 'ERROR', text: String(error).slice(0, 500) })
  await shot('99-异常').catch(() => {})
} finally {
  writeFileSync(REPORT, JSON.stringify(SUMMARY, null, 2), 'utf8')
  if (!KEEP) { await page.waitForTimeout(8000); await browser.close().catch(() => {}) }
  console.log('EVIDENCE=' + EVIDENCE)
}
