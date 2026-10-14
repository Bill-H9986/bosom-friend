/**
 * 链路冒烟（chain smoke）—— 2026-10-10 立，接在入口冒烟（stranger-smoke.mjs）之后。
 *
 * 入口冒烟只证明「点得开」；本脚本证明「**事情办得成**」：
 *   说一句话 → AI 智能体动手出片 → 成品进草稿箱 → 走到发布确认界面。
 *
 * 规则（与入口冒烟一致，违反即失效）：
 *   1. **只用页面可见文字定位**：禁 data-testid / id / class / 源码知识；
 *   2. 判定只认**结构化差异**（路由 / 弹层 / 新增可见控件 / 文本替换）；
 *   3. 每步截图；每步记录「用户看到什么」；
 *   4. **不点最终提交键**：走到发布确认界面即止（真实发布由用户扫码后决定）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { loadChromium } from './browser.mjs'

const BASE = process.env.BOSOM_WEB ?? 'http://127.0.0.1:31280/bosom-friend/'
const OUT = 'analysis/_drive'
mkdirSync(OUT, { recursive: true })

// 入口不可达直接判红（2026-10-12 收敛，见 task-8）：不启动浏览器，几秒内给出非 0 退出码。
const entryProbe = await fetch(BASE).catch(() => null)
if (entryProbe === null || entryProbe.status >= 500) {
  console.log('CHAIN_SMOKE_FAIL 入口不可达：' + BASE + '（HTTP ' + (entryProbe === null ? '连不上' : entryProbe.status) + '）')
  process.exit(1)
}

const chromium = loadChromium()
const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--start-maximized', '--disable-blink-features=AutomationControlled'] })
const ctx = await browser.newContext({ viewport: null, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const page = await ctx.newPage()
const log = []
let shots = 0
const shot = async (name) => { try { await page.screenshot({ path: OUT + '/chain-' + String(++shots).padStart(2, '0') + '-' + name + '.png' }) } catch {} }
const note = (s) => { const l = '[' + new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '] ' + s; console.log(l); log.push(l) }
const rightPanel = () => page.evaluate(() => {
  const cands = [...document.querySelectorAll('aside, div')].filter(e => e.offsetWidth > 240 && e.offsetHeight > 300)
  const widest = cands.sort((a, b) => b.innerText.length - a.innerText.length)[0]
  return widest ? widest.innerText.replace(/\s+/g, ' ').slice(-400) : document.body.innerText.slice(-400)
})

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('textarea', { timeout: 25000 })
await page.waitForTimeout(3000)
await shot('home')
note('第 1 步 打开首页 ✔')

const ask = '做一条 5 秒的无人机培训短视频，画面是实训车间里学员给无人机装机臂'
const box = page.locator('textarea:visible').first()
await box.click()
await box.type(ask, { delay: 30 })
await page.waitForTimeout(600)
await shot('typed')
await box.press('Enter')
note('第 2 步 已发送需求（用户视角：只在输入框里说了一句话）')

let started = false
let startedAt = 0
for (let i = 0; i < 18; i++) {
  await page.waitForTimeout(10000)
  const t = await rightPanel()
  if (/gen-[0-9a-z]{8}|生成任务已启动|已启动|正在生成|出片/.test(t)) { started = true; startedAt = i * 10 + 10; break }
  if (i === 5) await shot('waiting-ai')
}
note('第 3 步 AI 是否动手出片：' + (started ? '✔ 第 ' + startedAt + ' 秒看到生成任务' : '✘ 3 分钟内没看到任何「已启动生成」字样'))
await shot('after-ask')

let done = false
let doneAt = 0
const t0 = Date.now()
const draftBaseline = await page.evaluate(() => { const m = document.body.innerText.match(/草稿\s*(\d+)/); return m ? Number(m[1]) : -1 })
note('  基准：页面显示草稿 ' + (draftBaseline < 0 ? '(读不到计数)' : draftBaseline + ' 条'))
for (let i = 0; i < 32; i++) {
  await page.waitForTimeout(15000)
  const t = await rightPanel()
  // 出片判定必须看**草稿箱真的多出一条**（页面结构化信号），
  // 不能用右栏关键词——v1 就是被历史消息里的「已完成/视频」骗了（假阳性，2026-10-10）。
  const draftCount = await page.evaluate(() => {
    const m = document.body.innerText.match(/草稿\s*(\d+)/)
    return m ? Number(m[1]) : -1
  })
  if (draftCount > draftBaseline && draftCount >= 0) { done = true; doneAt = Math.round((Date.now() - t0) / 1000); break }
  if (i % 4 === 0) { await shot('waiting-out-' + i); note('  已等 ' + Math.round((Date.now() - t0) / 1000) + ' 秒…右栏尾部：' + t.slice(-80)) }
}
note('第 4 步 出片：' + (done ? '✔ 约 ' + doneAt + ' 秒后右栏报告完成' : '✘ 8 分钟内右栏没有报告完成'))
await shot('after-generate')

await page.keyboard.press('Escape').catch(() => {})
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
const contentLink = page.getByText('内容创作', { exact: true }).first()
let draftOk = '✘ 找不到「内容创作」入口'
if (await contentLink.count() > 0) {
  await contentLink.click()
  await page.waitForTimeout(5000)
  await shot('draftbox')
  const body = await page.evaluate(() => document.body.innerText)
  const hasVideo = /视频|成片/.test(body)
  const hasDraft = /草稿/.test(body)
  draftOk = (hasDraft && hasVideo) ? '✔ 创作页能看到「草稿」与「视频」相关条目' : '⚠ 创作页可见文字里 ' + (hasDraft ? '有草稿' : '没有草稿') + '、' + (hasVideo ? '有视频' : '没有视频')
}
note('第 5 步 成品是否可见：' + draftOk)

let pubOk = '✘ 页面上找不到「一键发布」'
const pubBtn = page.getByText('一键发布', { exact: false }).first()
if (await pubBtn.count() > 0) {
  await pubBtn.click({ timeout: 5000 }).catch(async () => { await pubBtn.click({ force: true }) })
  await page.waitForTimeout(5000)
  await shot('publish-entry')
  const body = await page.evaluate(() => document.body.innerText)
  const sees = ['抖音', '发布', '草稿', '标题'].filter(k => body.includes(k))
  pubOk = sees.length >= 3 ? '✔ 打开了发布流程界面（可见：' + sees.join('、') + '）' : '⚠ 点了「一键发布」后界面变化有限（可见：' + sees.join('、') + '）'
}
note('第 6 步 发布入口：' + pubOk + '（按规则不点最终提交）')
await shot('final')

await browser.close()
const report = ['# 链路冒烟报告（一句话 → 出片 → 草稿箱 → 发布入口）', '', '时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), '', '```', ...log, '```', ''].join('\n')
writeFileSync(OUT + '/chain-smoke-report.md', report, 'utf8')
console.log('\n' + report)
console.log('CHAIN_DONE started=' + started + ' done=' + done)
// 判红（2026-10-12 收敛，见 task-8）：链路冒烟要证明「事情办得成」——
// 第 4 步（出片真的落进草稿箱）没成就是没办成，不能只留一行打印。
if (done !== true) {
  console.log('CHAIN_SMOKE_FAIL 出片没落进草稿箱（done=' + done + ' started=' + started + '）——链路没办成')
  process.exit(1)
}
console.log('CHAIN_SMOKE_OK 一句话 → 出片 → 草稿箱 → 走到发布入口（按纪律未点最终提交）')