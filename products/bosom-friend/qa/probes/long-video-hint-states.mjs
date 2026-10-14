#!/usr/bin/env node
/**
 * 长视频「卖点字数 → 成稿门槛」三态提示验收（DEF-108 的对照提示）。
 *
 * 三态定义（`briefCharsHint`）：
 *   空      「还没填卖点：这条片要 N 字成稿…空着不会开始」
 *   不足    「卖点 N 字 → 这条片要 M 字成稿；差的字由后端自动补写…」
 *   已够    「卖点 N 字，已够这条片要的 M 字成稿」
 *
 * 判据：在真实页面上把三种输入做出来，读页面可见文本与它的颜色状态；
 * 做不出来的那一态要如实记下来（例如输入框自带长度上限时，"已够"可能根本到不了）。
 *
 * 只读参数、不下单：写卖点、点档位、读提示，不点「开始生成」。
 *
 * Usage: node products/bosom-friend/qa/probes/long-video-hint-states.mjs
 * @module qa/probes/long-video-hint-states
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'long-video-hint-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
const EVENTS = join(EVIDENCE, 'events.jsonl')
const REPORT = join(EVIDENCE, 'REPORT.json')
writeFileSync(EVENTS, '')
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')
const SUMMARY = { startedAt: new Date().toISOString(), status: 'running', states: {}, checks: [], pageErrors: [] }

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
/** 截图。 @param name - 文件名。 */
async function shot(name) { await page.screenshot({ path: join(EVIDENCE, name + '.png') }).catch(() => {}) }
/** 读 testid 文本。 @param id - data-testid。 */
async function textOf(id) {
  const locator = page.locator('[data-testid="' + id + '"]').first()
  if (await locator.count() === 0) return ''
  return ((await locator.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
}
/** 读提示的当前文案与颜色类。 @returns 文案与 class。 */
async function hint() {
  const locator = page.locator('[data-testid="long-video-brief-hint"]').first()
  if (await locator.count() === 0) return { text: '', cls: '' }
  return {
    text: ((await locator.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim(),
    cls: (await locator.getAttribute('class').catch(() => '')) ?? '',
  }
}
/** 把卖点输入框设成指定字数。 @param chars - 目标字数。 */
async function fillTopic(chars) {
  const field = page.locator('[data-testid="long-video-topic"]').first()
  await field.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  if (chars > 0) {
    // 逐段输入：一次 type 太长的文本在部分输入法下会丢字。
    const chunk = '秋冬保湿面霜主打干皮救急成分温和不刺激敏感肌也能用今天直播间直降一百前一百名送同款小样三件套点下方小黄车就能拍。'
    let text = ''
    while (text.length < chars) text += chunk
    await field.fill(text.slice(0, chars))
  }
  await page.waitForTimeout(2000)
}

try {
  await page.goto(BASE + '#/long-video', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="long-video-start"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(3000)
  if (await page.locator('[data-testid="long-video-start"]').first().isDisabled())
    throw new Error('长视频页有任务在生成，表单被禁用：等它跑完再验三态提示')

  // 先选 90 秒（门槛 369 字），再逐个把三态做出来
  await page.locator('[data-testid="long-video-duration-90"]').first().click()
  await page.waitForTimeout(3000)
  const need = await textOf('long-video-script-need')
  const required = Number(/(\d+)\s*字口播稿/.exec(need)?.[1] ?? 0)
  record({ kind: 'NEED', text: need })
  check('门槛文案给出 90 秒档的下限', required > 0, 'required=' + String(required))

  const maxLength = await page.locator('[data-testid="long-video-topic"]').first().getAttribute('maxlength').catch(() => null)
  SUMMARY.maxLength = maxLength

  // ① 空
  await fillTopic(0)
  const empty = await hint()
  SUMMARY.states.empty = empty
  await shot('01-空')
  check('空态提示说明还差多少且不会开始', /还没填卖点/.test(empty.text) && /空着不会开始/.test(empty.text), empty.text.slice(0, 160))

  // ② 不足
  await fillTopic(64)
  const short = await hint()
  SUMMARY.states.short = short
  await shot('02-不足')
  check('不足态提示给出「卖点 N 字 → 门槛 M 字」', /卖点 64 字/.test(short.text) && short.text.includes(String(required)), short.text.slice(0, 200))
  check('不足态用醒目颜色（不是次要灰）', /amber/.test(short.cls), 'class=' + short.cls.slice(0, 160))

  // ③ 已够
  await fillTopic(required + 10)
  const filledNow = await page.locator('[data-testid="long-video-topic"]').first().inputValue().catch(() => '')
  const enough = await hint()
  SUMMARY.states.enough = enough
  SUMMARY.filledChars = filledNow.length
  await shot('03-已够')
  const reachedEnough = /已够这条片要的/.test(enough.text)
  check('已够态提示「已够这条片要的 N 字成稿」', reachedEnough,
    '输入框实际字数=' + String(filledNow.length) + '（maxlength=' + String(maxLength) + '），提示=' + enough.text.slice(0, 160))
  if (!reachedEnough) {
    record({
      kind: 'NOTE',
      text: '「已够」这一态在本档位做不出来：门槛 ' + String(required) + ' 字，而卖点输入框上限是 '
        + String(maxLength) + ' 字 —— 用户按提示补到上限也到不了「已够」。',
    })
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
  await page.waitForTimeout(3000)
  await browser.close().catch(() => {})
  const failed = SUMMARY.checks.filter(item => !item.ok)
  console.log('LONG_VIDEO_HINT ' + (SUMMARY.status === 'passed' ? 'PASS' : 'FAIL') + ' checks=' + String(SUMMARY.checks.length) + ' fail=' + String(failed.length))
  console.log('EVIDENCE=' + EVIDENCE)
  process.exit(SUMMARY.status === 'passed' ? 0 : 1)
}
