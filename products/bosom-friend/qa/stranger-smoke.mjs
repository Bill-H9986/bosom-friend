/**
 * 陌生用户冒烟 v2 —— 结构化判定版（2026-10-10）。
 *
 * v1 的教训（当天自己发现）：判定写成「页面文本包含某关键词」，而页面上到处是「抖音」「模式」
 * 「重新生成」这类字样，于是"点了没反应"也能判成通过——正是产品负责人反复批评的**假阳性**。
 * v2 的判定只认**操作前后的结构化差异**：URL 变化 / 可见按钮集合新增 / 文本长度显著变化 /
 * 弹出层出现。看不到差异就是失败，不管页面上写着什么。
 *
 * 规则不变：只用页面可见文字定位；禁止 data-testid / 源码知识；只做只读冒烟。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { loadChromium } from './browser.mjs'

const BASE = process.env.BOSOM_WEB ?? 'http://127.0.0.1:31280/bosom-friend/'
const OUT = 'analysis/_drive'
mkdirSync(OUT, { recursive: true })

// 入口不可达直接判红（2026-10-12 收敛，见 task-8）：这不是「点了没反应」，是根本没打开页面。
// 探测放在启动浏览器之前，负向对照（BOSOM_WEB 指向死端口）几秒内就能拿到非 0 退出码。
const entryProbe = await fetch(BASE).catch(() => null)
if (entryProbe === null || entryProbe.status >= 500) {
  console.log('STRANGER_SMOKE_FAIL 入口不可达：' + BASE + '（HTTP ' + (entryProbe === null ? '连不上' : entryProbe.status) + '）')
  process.exit(1)
}

const chromium = loadChromium()
const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--start-maximized', '--disable-blink-features=AutomationControlled'] })
const ctx = await browser.newContext({ viewport: null, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const page = await ctx.newPage()
const results = []
let n = 0
const shot = async (name) => { try { await page.screenshot({ path: OUT + '/smoke2-' + String(++n).padStart(2, '0') + '-' + name + '.png' }) } catch {} }

/** 结构化快照：只取会影响判定的硬信号。 */
async function snap() {
  return await page.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight)
    const labels = [...document.querySelectorAll('button, [role="button"], a, [role="menuitem"]')]
      .filter(vis).map(e => (e.textContent || '').trim()).filter(t => t && t.length < 24)
    const overlays = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], .modal, [class*="dialog"], [class*="modal"], [class*="popover"], [class*="dropdown"]')]
      .filter(vis).length
    const body = document.body.innerText
    return { url: location.hash || location.pathname, labels, overlays, textLen: body.length, head: body.slice(0, 120).replace(/\s+/g, ' '), tail: body.slice(-220).replace(/\s+/g, ' ') }
  })
}

function diff(before, after) {
  const added = after.labels.filter(l => !before.labels.includes(l))
  const urlChanged = before.url !== after.url
  const overlayAppeared = after.overlays > before.overlays
  const textGrew = after.textLen - before.textLen > 40
  const reasons = []
  if (urlChanged) reasons.push('路由变化 ' + before.url + ' → ' + after.url)
  if (overlayAppeared) reasons.push('弹出层出现(可见层 ' + before.overlays + '→' + after.overlays + ')')
  if (added.length) reasons.push('新增可见控件「' + added.slice(0, 4).join('、') + '」')
  if (textGrew && !added.length && !overlayAppeared) reasons.push('文本增加 ' + (after.textLen - before.textLen) + ' 字')
  // 文本被"替换"也算反应（v3 的假阴性：欢迎语被消息换掉，字数反而变少）。
  const textReplaced = before.tail !== after.tail && Math.abs(after.textLen - before.textLen) > 15
  if (textReplaced && !reasons.length) reasons.push('页面文本变化（' + before.textLen + ' → ' + after.textLen + ' 字，尾部内容已变）')
  return reasons
}

/** 找可见文字入口（严格：文字必须精确出现且可见）。 */
async function findClickable(text, exact = false) {
  const loc = page.getByText(text, { exact })
  const c = await loc.count()
  for (let i = 0; i < c; i++) {
    const el = loc.nth(i)
    if (await el.isVisible().catch(() => false)) return el
  }
  return null
}

/** 隔离：每步都从干净的首页状态开始（前一步的弹层会污染后面的判定）。 */
async function reset() {
  await page.keyboard.press('Escape').catch(() => {})
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // 等"首屏真的渲染完"，而不是盲等固定秒数（v2 的假阴性就是等待不足造成的）。
  await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 25000 }).catch(() => {})
  await page.waitForTimeout(2500)
}

async function step(want, howFind, expect, fn) {
  await reset()
  const before = await snap()
  let note = ''
  try { note = await fn(before) } catch (e) { note = '操作异常：' + String(e).slice(0, 100) }
  const after = await snap()
  const reasons = diff(before, after)
  const pass = reasons.length > 0
  const rec = { want, howFind, expect, evidence: pass ? reasons.join('；') : '点击前后**没有任何结构化变化**', note, verdict: pass ? 'PASS' : 'FAIL' }
  results.push(rec)
  console.log((pass ? '✅' : '❌') + ' ' + want + ' → ' + (pass ? reasons.join('；') : '无变化') + (note ? ' | ' + note : ''))
  return rec
}

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(8000)
await shot('home')
const home = await snap()
console.log('首屏：url=' + home.url + ' | 可见控件 ' + home.labels.length + ' 个 | 文本 ' + home.textLen + ' 字')

await step('左侧栏点「内容创作」', '按文字找左侧导航', '进入创作页', async () => {
  const el = await findClickable('内容创作', true)
  if (!el) return '找不到「内容创作」'
  await el.click({ timeout: 5000 })
  await page.waitForTimeout(3500)
  await shot('content')
})

await step('左侧栏点「我的任务」', '按文字找左侧导航', '进入任务页', async () => {
  const el = await findClickable('我的任务', false)
  if (!el) return '首页左侧导航里找不到「我的任务」'
  await el.click({ timeout: 5000 })
  await page.waitForTimeout(3000)
  await shot('tasks')
})

await step('在 AI 助手输入框发一句话', '首页右侧的输入框', '能输入并能发送', async () => {
  await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 20000 }).catch(() => {})
  const boxes = page.locator('textarea:visible, [contenteditable="true"]:visible')
  const c = await boxes.count()
  if (c === 0) return '**首页上找不到任何可见输入框**（AI 助手栏可能是收起状态）'
  const box = boxes.first()
  await box.click({ timeout: 5000 })
  await box.type('你好', { delay: 30 })
  await page.waitForTimeout(400)
  await box.press('Enter')
  await page.waitForTimeout(7000)
  await shot('ask')
})

await step('点最像「生成」的按钮', '找「生成草稿…」文字', '有反应（菜单/弹窗/提示）', async () => {
  const el = (await findClickable('生成草稿(视频)', false)) ?? (await findClickable('生成草稿', false)) ?? (await findClickable('生成', false))
  if (!el) return '找不到任何生成按钮'
  await el.click({ timeout: 5000 }).catch(async () => { await el.click({ force: true }) })
  await page.waitForTimeout(2500)
  await shot('generate')
})

await step('点「添加频道」看账号状态', '按文字找添加频道', '打开账号面板/看到登录状态', async () => {
  const el = (await findClickable('添加频道', false)) ?? (await findClickable('频道', false))
  if (!el) return '找不到账号入口'
  await el.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(3000)
  await shot('channel')
})

await browser.close()
const failed = results.filter(r => r.verdict === 'FAIL')
const lines = [
  '# 陌生用户冒烟 v2（结构化判定）',
  '',
  '时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '　入口：' + BASE,
  '',
  '判定规则：**只认点击前后的结构化差异**（路由 / 弹出层 / 新增可见控件 / 文本显著增长）。',
  '页面里写着什么都不算证据 —— 这是 v1 假阳性（"抖音""模式"到处都有）的直接修正。',
  '',
  '**结果：' + (results.length - failed.length) + '/' + results.length + ' 有真实反应，' + failed.length + ' 处点了没有任何变化**',
  '',
  '| # | 用户动作 | 会怎么找 | 期待 | 实际的结构化变化 | 判定 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...results.map((r, i) => '| ' + (i + 1) + ' | ' + r.want + ' | ' + r.howFind + ' | ' + r.expect + ' | ' + r.evidence.replace(/\|/g, '/') + (r.note ? '（' + r.note.replace(/\|/g, '/') + '）' : '') + ' | ' + (r.verdict === 'PASS' ? '✅' : '❌') + ' |'),
  '',
]
writeFileSync(OUT + '/stranger-smoke-v2-report.md', lines.join('\n'), 'utf8')
console.log('\n' + lines.join('\n'))
console.log('SMOKE2_DONE 失败=' + failed.length)
// 判红（2026-10-12 收敛，见 task-8）：任何一处「点了没有任何变化」都是陌生用户走不通，
// 必须非 0，否则这盏灯在编排里永远绿。
if (failed.length > 0) {
  console.log('STRANGER_SMOKE_FAIL ' + failed.length + '/' + results.length + ' 处点了没有任何变化（报告：' + OUT + '/stranger-smoke-v2-report.md）')
  process.exitCode = 1
} else {
  console.log('STRANGER_SMOKE_OK ' + results.length + ' 处都有真实结构化反应')
}
