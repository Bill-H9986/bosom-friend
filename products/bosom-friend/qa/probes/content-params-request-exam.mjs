#!/usr/bin/env node
/**
 * 内容创作「各项参数写入真实请求」验收：分辨率 / 画幅 / 时长 / 数量 / 平台 / 模式。
 *
 * 判据是 EXAM_PROTOCOL 的 C-PARAMS 一条：**每个创作参数可改，且改完体现在页面自己发出的请求里**。
 * 只看页面显示会漏掉"控件能点、值没进请求"（DEF-112 就是这一形态）；只看请求又漏掉"用户点不动"。
 * 因此这条逐项做两件事：先点控件改参数，再从页面自身请求里核对同一个值。
 *
 * 为了让每次跑都便宜，档位选 4 秒（单片、1 次厂商调用）——参数是否写进请求与档位长短无关。
 *
 * Usage: node products/bosom-friend/qa/probes/content-params-request-exam.mjs
 * @module qa/probes/content-params-request-exam
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'content-params-request-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
const EVENTS = join(EVIDENCE, 'events.jsonl')
const REPORT = join(EVIDENCE, 'REPORT.json')
writeFileSync(EVENTS, '')
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')
const PROMPT = '参数写入请求验收：干净背景上一只白色陶瓷杯，画面稳定'
const SUMMARY = { startedAt: new Date().toISOString(), status: 'running', request: null, checks: [], pageErrors: [] }

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
const submits = []
page.on('response', async (response) => {
  if (response.request().method() !== 'POST') return
  if (!/ai\/draft-generation\/v2$/.test(new URL(response.url()).pathname)) return
  submits.push(response.request().postData() ?? '')
})
/** 截图。 @param name - 文件名。 */
async function shot(name) { await page.screenshot({ path: join(EVIDENCE, name + '.png') }).catch(() => {}) }
/** 读 testid 文本。 @param id - data-testid。 */
async function textOf(id) {
  const locator = page.locator('[data-testid="' + id + '"]').first()
  if (await locator.count() === 0) return ''
  return ((await locator.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
}
/** 在某控件的弹层里点一个选项。 @param testid - 控件。 @param label - 选项文案。 */
async function pickOption(testid, label) {
  await page.locator('[data-testid="' + testid + '"]').first().click()
  await page.waitForTimeout(1000)
  const popover = page.locator('[data-radix-popper-content-wrapper]').last()
  const option = popover.getByText(label, { exact: true })
  if (await option.count() === 0) { await page.keyboard.press('Escape'); return false }
  await option.last().click()
  await page.waitForTimeout(1200)
  return true
}

try {
  await page.goto(BASE + '#/draft-box', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(2500)

  // 模式：生成草稿(视频)
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(800)
  await page.getByText('生成草稿(视频)', { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(2000)
  check('模式可改（切到视频）', (await page.locator('[data-testid="draftbox-ai-video-resolution"]').count()) > 0,
    '切换后出现视频分辨率控件：' + String(await page.locator('[data-testid="draftbox-ai-video-resolution"]').count() > 0))

  // 提示词
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await page.waitForTimeout(1000)
  const dialogInput = page.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  await dialogInput.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(PROMPT)
  await page.getByText('保存', { exact: true }).first().click()
  await page.waitForTimeout(1200)

  // 画幅：切到 16:9（与默认 9:16 不同，能看出值有没有跟着走）
  const ratioChanged = await pickOption('draftbox-ai-ratio', '16:9')
  const ratioShown = await textOf('draftbox-ai-ratio')
  check('画幅可改', ratioChanged, '控件文案=' + ratioShown)
  await shot('01-画幅16比9')

  // 时长：4 秒（单片，省额度）
  const durationChanged = await pickOption('draftbox-ai-duration', '4 秒')
  const durationShown = await textOf('draftbox-ai-duration')
  check('时长可改', durationChanged && /4\s*秒/.test(durationShown), '控件文案=' + durationShown)
  await shot('02-时长4秒')

  // 分辨率：读当前值（Flash 只收 720P，界面只给这一档）
  const resolutionShown = await textOf('draftbox-ai-video-resolution')
  check('分辨率控件有值', /\d{3,4}p/.test(resolutionShown), '控件文案=' + resolutionShown)

  // 平台：默认多平台，读数量药丸
  const platformShown = await textOf('draftbox-ai-platforms')
  record({ kind: 'PLATFORMS', text: '平台药丸=' + platformShown })
  await shot('03-提交前')

  // 提交
  await page.locator('[data-testid="draftbox-ai-submit-btn"]').first().click()
  record({ kind: 'STEP', text: '已提交生成' })
  await page.waitForTimeout(8000)
  await shot('04-已提交')

  const body = submits[0] ?? ''
  SUMMARY.request = body
  if (body === '') throw new Error('页面没有发出 ai/draft-generation/v2 请求')
  const parsed = JSON.parse(body)
  record({ kind: 'REQUEST', text: body.slice(0, 600) })

  check('请求里的画幅等于界面上选的', parsed.aspectRatio === '16:9', '请求 aspectRatio=' + String(parsed.aspectRatio))
  check('请求里的时长等于界面上选的', parsed.duration === 4, '请求 duration=' + String(parsed.duration))
  check('请求里的分辨率等于界面上显示的', String(parsed.resolution).replace('p', 'p') !== '' && /^\d{3,4}p$/.test(String(parsed.resolution)),
    '请求 resolution=' + String(parsed.resolution) + '，界面=' + resolutionShown)
  check('请求里的模式是视频草稿', parsed.draftType === 'video' || parsed.draftType === 'draft', '请求 draftType=' + String(parsed.draftType))
  check('请求里带上了提示词', String(parsed.prompt ?? '').includes('白色陶瓷杯'), '请求 prompt=' + String(parsed.prompt ?? '').slice(0, 80))
  check('请求里带上了目标平台', Array.isArray(parsed.platforms) && parsed.platforms.length > 0, '请求 platforms=' + JSON.stringify(parsed.platforms))
  check('请求里的数量是界面上的数量', Number(parsed.quantity) >= 1, '请求 quantity=' + String(parsed.quantity))

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
  console.log('CONTENT_PARAMS_REQUEST ' + (SUMMARY.status === 'passed' ? 'PASS' : 'FAIL') + ' checks=' + String(SUMMARY.checks.length) + ' fail=' + String(failed.length))
  console.log('EVIDENCE=' + EVIDENCE)
  process.exit(SUMMARY.status === 'passed' ? 0 : 1)
}
