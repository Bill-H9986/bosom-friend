#!/usr/bin/env node
/**
 * 长视频创作「各项参数」真实前端验收（只读参数，不建任务）。
 *
 * 覆盖用户能改的每一个参数：内容形式（含数字人形象）、目标时长、画幅、画面字幕、产品图入口。
 * 判据分两层：
 *   ① 页面可见：档位按钮的选中态、字数门槛与预估随参数变化；
 *   ② 页面自己的请求：选时长后页面会问后端"这条要多少字口播稿"，
 *      该请求体里的 targetSeconds 必须等于用户刚选的档位（"参数控件可改且写入真实请求"）。
 *
 * 刻意不下单：长视频一条要跑几十分钟、还要花厂商额度。要证明"能出片"由
 * long-video-frontend-exam.mjs / long-video-resume-exam.mjs 负责，这条只钉参数口径。
 *
 * Usage: node products/bosom-friend/qa/probes/long-video-params-exam.mjs
 * @module qa/probes/long-video-params-exam
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'long-video-params-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
const EVENTS = join(EVIDENCE, 'events.jsonl')
const REPORT = join(EVIDENCE, 'REPORT.json')
writeFileSync(EVENTS, '')
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')
const SUMMARY = { startedAt: new Date().toISOString(), status: 'running', steps: [], pageErrors: [], checks: [] }

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
page.on('pageerror', error => { SUMMARY.pageErrors.push(String(error)); record({ kind: 'PAGEERROR', text: String(error).slice(0, 300) }) })

/** 页面自己发出的字数门槛请求（参数有没有真的写进去，就看它）。 */
const scriptRequests = []
page.on('request', (request) => {
  if (!/long-videos\/script-requirement/.test(request.url())) return
  const params = {}
  for (const [key, value] of new URL(request.url()).searchParams) params[key] = value
  scriptRequests.push(params)
})

/** 截图。 @param name - 文件名。 */
async function shot(name) { await page.screenshot({ path: join(EVIDENCE, name + '.png') }).catch(() => {}) }
/** 读 testid 文本。 @param id - data-testid。 */
async function textOf(id) {
  const locator = page.locator('[data-testid="' + id + '"]').first()
  if (await locator.count() === 0) return ''
  return ((await locator.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
}
/**
 * 按钮是不是"选中态"。
 *
 * 判据是该页面自己的按钮类名（选中 `btn-primary`、未选中 `btn-outline`），
 * 不是 shadcn 的 `bg-primary`——实测 2026-09-19 抓到的 class 是 `btn btn-primary btn-sm`。
 * @param id - data-testid。
 * @returns 是否选中。
 */
async function isActive(id) {
  const cls = await page.locator('[data-testid="' + id + '"]').first().getAttribute('class').catch(() => '') ?? ''
  return /btn-primary/.test(cls)
}
/** 等门槛文案稳定下来。 @returns 门槛文案。 */
async function waitScriptNeed() {
  for (let i = 0; i < 15; i += 1) {
    const text = await textOf('long-video-script-need')
    if (text !== '') return text
    await page.waitForTimeout(1000)
  }
  return ''
}

try {
  await page.goto(BASE + '#/long-video', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="long-video-start"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(3000)
  const startDisabled = await page.locator('[data-testid="long-video-start"]').first().isDisabled()
  if (startDisabled) throw new Error('页面上还有任务在生成，表单被禁用：等它跑完再跑这条参数验收')
  record({ kind: 'STEP', text: '长视频页已打开，表单可用' })
  await shot('01-长视频页-表单可用')

  // ① 目标时长：三档都要能选，且门槛/预估随档位变化，页面请求里的 targetSeconds 与所选一致。
  const durations = [90, 120, 300]
  const needs = {}
  // 先把档位挪开再逐个点回来：进页面时默认就是 90 秒，直接点它状态没变、页面不会发请求，
  // 判定会把这个"没发出请求"误读成"参数没写进请求"（实测 2026-09-19）。
  await page.locator('[data-testid="long-video-duration-300"]').first().click()
  await page.waitForTimeout(3000)
  for (const seconds of durations) {
    scriptRequests.length = 0
    await page.locator('[data-testid="long-video-duration-' + String(seconds) + '"]').first().click()
    await page.waitForTimeout(2500)
    const need = await waitScriptNeed()
    needs[seconds] = need
    const required = Number(/(\d+)\s*字口播稿/.exec(need)?.[1] ?? 0)
    const request = scriptRequests[scriptRequests.length - 1] ?? null
    check('时长 ' + String(seconds) + ' 秒可选中', await isActive('long-video-duration-' + String(seconds)), '按钮选中态=' + String(await isActive('long-video-duration-' + String(seconds))))
    check('时长 ' + String(seconds) + ' 秒的门槛文案带出该档位', need.includes(String(seconds) + ' 秒') && required > 0, need.slice(0, 120))
    check('时长 ' + String(seconds) + ' 秒写进页面请求', request !== null && Number(request.targetSeconds) === seconds, '请求参数=' + JSON.stringify(request))
    await shot('02-时长-' + String(seconds) + '秒')
  }
  const requiredOf = seconds => Number(/(\d+)\s*字口播稿/.exec(needs[seconds] ?? '')?.[1] ?? 0)
  check('门槛随档位单调变长', requiredOf(90) < requiredOf(120) && requiredOf(120) < requiredOf(300),
    '90→' + String(requiredOf(90)) + ' 字，120→' + String(requiredOf(120)) + ' 字，300→' + String(requiredOf(300)) + ' 字')

  // ② 画幅：三档互斥选中，页面可见。
  for (const ratio of ['9:16', '16:9', '1:1']) {
    const id = 'long-video-ratio-' + ratio.replace(':', '-')
    await page.locator('[data-testid="' + id + '"]').first().click()
    await page.waitForTimeout(800)
    const active = await isActive(id)
    const others = await Promise.all(['9:16', '16:9', '1:1'].filter(r => r !== ratio)
      .map(r => isActive('long-video-ratio-' + r.replace(':', '-'))))
    check('画幅 ' + ratio + ' 可选中且互斥', active && others.every(v => !v), '本档选中=' + String(active) + '，其余=' + JSON.stringify(others))
  }
  await shot('03-画幅')

  // ③ 画面字幕开关：状态真的翻转，且翻回原状。
  const subsInitial = await page.locator('[data-testid="long-video-subtitles"]').first().getAttribute('data-state').catch(() => '')
  await page.locator('[data-testid="long-video-subtitles"]').first().click()
  await page.waitForTimeout(600)
  const subsToggled = await page.locator('[data-testid="long-video-subtitles"]').first().getAttribute('data-state').catch(() => '')
  await page.locator('[data-testid="long-video-subtitles"]').first().click()
  await page.waitForTimeout(600)
  const subsBack = await page.locator('[data-testid="long-video-subtitles"]').first().getAttribute('data-state').catch(() => '')
  check('画面字幕开关可切换', subsInitial !== subsToggled && subsBack === subsInitial,
    '初始=' + String(subsInitial) + '，切换后=' + String(subsToggled) + '，切回=' + String(subsBack))
  await shot('04-画面字幕')

  // ④ 内容形式：数字人口播需要形象，切到不需要形象的形式时形象选择区应当消失。
  const humanPickerVisible = await page.locator('[data-testid^="long-video-human-"]').count() > 0
  const producerIds = await page.locator('[data-testid^="long-video-producer-"]').evaluateAll(list => list.map(el => el.getAttribute('data-testid')))
  check('内容形式至少两档可选', producerIds.length >= 2, JSON.stringify(producerIds))
  let switched = false
  for (const id of producerIds) {
    await page.locator('[data-testid="' + String(id) + '"]').first().click()
    await page.waitForTimeout(1500)
    const nowVisible = await page.locator('[data-testid^="long-video-human-"]').count() > 0
    if (nowVisible !== humanPickerVisible) switched = true
  }
  check('切换内容形式会改变形象选择区', switched, '初始形象区可见=' + String(humanPickerVisible))
  await shot('05-内容形式')

  // ⑤ 产品图入口：可选参数也要有真实入口（不传也能生成）。
  const picker = await page.locator('[data-testid="long-video-product-image-pick"]').count()
  check('产品图入口存在且不是必填', picker > 0, '入口数=' + String(picker))

  SUMMARY.status = SUMMARY.checks.every(item => item.ok) ? 'passed' : 'failed'
} catch (error) {
  SUMMARY.status = 'error'
  SUMMARY.error = String(error).slice(0, 800)
  record({ kind: 'ERROR', text: SUMMARY.error.slice(0, 400) })
  await shot('99-异常')
} finally {
  SUMMARY.pageErrorsCount = SUMMARY.pageErrors.length
  SUMMARY.finishedAt = new Date().toISOString()
  writeFileSync(REPORT, JSON.stringify(SUMMARY, null, 2), 'utf8')
  await page.waitForTimeout(3000)
  await browser.close().catch(() => {})
  const failed = SUMMARY.checks.filter(item => !item.ok)
  console.log('LONG_VIDEO_PARAMS ' + (SUMMARY.status === 'passed' ? 'PASS' : 'FAIL') + ' checks=' + String(SUMMARY.checks.length) + ' fail=' + String(failed.length))
  console.log('EVIDENCE=' + EVIDENCE)
  process.exit(SUMMARY.status === 'passed' ? 0 : 1)
}
