#!/usr/bin/env node
/**
 * 长视频「从断点继续」真实前端验收：把一条被应用退出打断的任务接着跑完，
 * 并把页面可见的逐镜进度、终态、分镜清单与成片规格全部归档。
 *
 * 只做三件被允许的事：打开页面、点真实控件、读页面可见文本与截图。
 * 不调用产品业务接口、不读写产品数据文件；ffmpeg 只读成片文件的元数据（诊断用）。
 *
 * 与 long-video-frontend-exam.mjs 的分工：那条从零建新任务，这条只接手已有的中断任务，
 * 用来证明「应用重启后已跑成的镜不白花、能接着跑完」。
 *
 * Usage: node products/bosom-friend/qa/probes/long-video-resume-exam.mjs [--keep]
 * @module qa/probes/long-video-resume-exam
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const args = process.argv.slice(2)
// 证据目录按 --tag 走：同一天可能跑好几次验收，各留各的。
const tagArg = args.indexOf('--tag')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'long-video-' + (tagArg >= 0 ? String(args[tagArg + 1]) : '2026-09-19'))
mkdirSync(EVIDENCE, { recursive: true })
const EVENTS = join(EVIDENCE, 'events-resume.jsonl')
const REPORT = join(EVIDENCE, 'REPORT-resume.json')
writeFileSync(EVENTS, '')

const KEEP = args.includes('--keep')
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')
const SUMMARY = { startedAt: new Date().toISOString(), steps: [], status: 'running', beforeText: '', beforeReady: null, shotsTotal: null, shotsReady: null, produced: '', videoUrl: '', ffprobe: '', pageErrors: [] }

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
/**
 * 数分镜清单里已生成的镜数。
 *
 * 判据用"还没有等待中"而不是"有已生成"：清单行本身不写"已生成"三个字，
 * 跑成的镜显示"重做"按钮，没跑成的显示"等待中"（实测 2026-09-19）。
 * @returns 分镜总数与已出片数。
 */
async function shotCounts() {
  const items = page.locator('[data-testid="long-video-shots"] li')
  const total = await items.count()
  let ready = 0
  for (let i = 0; i < total; i += 1) {
    const text = ((await items.nth(i).textContent().catch(() => '')) ?? '')
    if (!/等待中/.test(text)) ready += 1
  }
  return { total, ready }
}

try {
  await page.goto(BASE + '#/long-video', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="long-video-resume"], [data-testid="long-video-progress"], [data-testid="long-video-start"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(4000)
  SUMMARY.beforeText = await textOf('long-video-progress')
  const before = await shotCounts()
  SUMMARY.beforeReady = before.ready
  SUMMARY.shotsTotal = before.total
  record({ kind: 'BEFORE', text: '续跑前：' + SUMMARY.beforeText + ' | 分镜 ' + String(before.ready) + '/' + String(before.total) + ' 已生成' })
  await shot('05-断点续跑前')
  await page.locator('[data-testid="long-video-resume"]').first().scrollIntoViewIfNeeded().catch(() => {})
  await page.waitForTimeout(600)
  await shot('06-断点续跑按钮')

  const startedAt = Date.now()
  await page.locator('[data-testid="long-video-resume"]').first().click()
  record({ kind: 'RESUME', text: '已点击「从断点继续」' })
  await page.waitForTimeout(5000)
  await shot('07-续跑已提交')

  let lastKey = ''
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
    const key = [phase, count, chars, produced, errorText, result].join('|')
    if (key !== lastKey) {
      lastKey = key
      record({ kind: 'PROGRESS', minutes: elapsedMin, text: phase + ' | ' + count + ' | ' + chars + ' | ' + produced + (errorText ? ' | 错误=' + errorText : '') })
    }
    if (index % 6 === 0) await shot('resume-progress-' + String(elapsedMin).padStart(3, '0') + 'm')
    const counts = await shotCounts()
    SUMMARY.shotsTotal = counts.total
    SUMMARY.shotsReady = counts.ready

    const videoShown = await page.locator('[data-testid="long-video-result"]').count() > 0
    if (videoShown || errorText !== '') {
      SUMMARY.status = errorText !== '' ? 'failed' : 'success'
      SUMMARY.produced = produced
      SUMMARY.errorText = errorText
      SUMMARY.videoUrl = await page.locator('[data-testid="long-video-result"] video').first().getAttribute('src').catch(() => '') ?? ''
      await shot('99-终态-续跑')
      break
    }
    if ((Date.now() - startedAt) > 150 * 60_000) { SUMMARY.status = 'timeout'; await shot('99-超时-续跑'); break }
  }

  const rows = []
  const items = page.locator('[data-testid="long-video-shots"] li')
  const total = await items.count()
  for (let i = 0; i < total; i += 1) rows.push(((await items.nth(i).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 140))
  SUMMARY.shots = rows
  SUMMARY.finishedAt = new Date().toISOString()
  SUMMARY.minutes = Math.round((Date.now() - startedAt) / 60_000)

  const fileName = (SUMMARY.videoUrl || '').split('/').pop() ?? ''
  SUMMARY.videoFile = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend', 'uploads', fileName)
  SUMMARY.videoExists = fileName !== '' && existsSync(SUMMARY.videoFile)
  if (SUMMARY.videoExists) {
    const ffprobe = join(PRODUCT, 'desktop', 'dist', 'runtime', 'ffmpeg.exe')
    const probe = spawnSync(ffprobe, ['-hide_banner', '-i', SUMMARY.videoFile], { encoding: 'utf8' })
    SUMMARY.ffprobe = String(probe.stderr ?? '').split('\n').filter(line => /Duration|Stream #/.test(line)).join(' | ').trim()
    record({ kind: 'FFPROBE', text: SUMMARY.ffprobe })
  }
  record({ kind: 'DONE', text: 'status=' + SUMMARY.status + ' minutes=' + String(SUMMARY.minutes) + ' shots=' + String(SUMMARY.shotsReady) + '/' + String(SUMMARY.shotsTotal) })
} catch (error) {
  SUMMARY.status = 'error'
  SUMMARY.error = String(error).slice(0, 1000)
  record({ kind: 'ERROR', text: String(error).slice(0, 500) })
  await shot('99-异常-续跑').catch(() => {})
} finally {
  writeFileSync(REPORT, JSON.stringify(SUMMARY, null, 2), 'utf8')
  if (!KEEP) { await page.waitForTimeout(8000); await browser.close().catch(() => {}) }
  console.log('EVIDENCE=' + EVIDENCE)
}
