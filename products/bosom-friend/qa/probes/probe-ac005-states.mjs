/**
 * AC-005 三态的前端证据探针：未配置 / 配置错误时，页面必须如实说，不许编内容。
 *
 * 做法：临时移开 llm-user.json（或写入一个错误密钥）→ 用全新浏览器上下文打开应用 →
 * 在右侧 AI 助手里发一句话 → 截图 → finally 原样还原配置。
 * 全新上下文很关键：前端会把模型配置存 localStorage，沿用旧上下文会带着可用配置。
 *
 * 用法：node products/bosom-friend/qa/probes/probe-ac005-states.mjs
 */
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const DATA_ROOT = process.env.BOSOM_FRIEND_HOME ?? join(homedir(), '.bosom-friend', 'bosom-friend')
const CFG = join(DATA_ROOT, 'llm-user.json')
const BAK = CFG + '.ac005-probe-bak'
const OUT = join(import.meta.dirname, 'agent-board')
const report = { base: BASE, at: new Date().toISOString(), steps: [] }

async function acceptDisclaimer(page) {
  for (let i = 0; i < 8; i++) {
    for (const label of ['我已阅读并同意', '同意并进入平台']) {
      const button = page.locator(`button:has-text('${label}')`).first()
      if (await button.count() > 0 && await button.isVisible().catch(() => false))
        await button.click({ timeout: 3000 }).catch(() => {})
    }
    await page.waitForTimeout(400)
  }
}

const listTaskIds = async () => {
  const response = await fetch(BASE + 'api/agent/tasks?page=1&pageSize=20')
  const json = await response.json().catch(() => null)
  return (json?.data?.list ?? []).map(item => item.id)
}

/** 探针自己造的任务用完即删，别留在「我的任务」里。 */
async function dropTasksCreatedAfter(before) {
  const now = await listTaskIds()
  for (const id of now.filter(item => !before.includes(item)))
    await fetch(BASE + 'api/agent/tasks/' + id, { method: 'DELETE' }).catch(() => {})
}

/** 全新上下文里发一句话，返回侧栏最后一条 AI 文案与截图路径。 */
async function askInFreshContext(browser, prompt, shot) {
  const before = await listTaskIds()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(7000)
  await acceptDisclaimer(page)
  const panel = page.locator('[data-testid=ai-assistant-sidebar]').first()
  const input = panel.locator('textarea').first()
  await input.fill(prompt)
  await panel.locator('button[aria-label="发送"]').last().click({ timeout: 15000 })
  // 固定提示是打字机式推送，等它稳定下来再取文案。
  await page.waitForTimeout(12000)
  const body = (await panel.innerText().catch(() => '')).replace(/\s+/g, ' ')
  await page.screenshot({ path: join(OUT, shot) })
  await context.close()
  await dropTasksCreatedAfter(before)
  return body
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const hadConfig = existsSync(CFG)
const original = hadConfig ? readFileSync(CFG, 'utf8') : null
try {
  // 状态一：没有配置 —— 必须说「未接入任何大模型」
  if (hadConfig) copyFileSync(CFG, BAK)
  if (hadConfig) renameSync(CFG, CFG + '.ac005-hidden')
  const unconfigured = await askInFreshContext(browser, '帮我写一条抖音文案。', '09-ac005-unconfigured.png')
  report.steps.push({ state: 'unconfigured', hit: unconfigured.includes('未接入任何大模型'), text: unconfigured.slice(-160) })
  if (hadConfig) renameSync(CFG + '.ac005-hidden', CFG)
  await new Promise(resolve => setTimeout(resolve, 800))

  // 状态二：配置存在但密钥错误 —— 必须说「大模型调用失败」，不许回落模板
  if (hadConfig) {
    const broken = JSON.parse(original)
    broken.apiKey = 'sk-invalid-ac005'
    writeFileSync(CFG, JSON.stringify(broken, null, 2), 'utf8')
    const failed = await askInFreshContext(browser, '帮我写一条抖音文案。', '10-ac005-failed.png')
    const fellBackToTemplate = /第一步：明确目标|小贴士/.test(failed)
    report.steps.push({ state: 'failing', hit: failed.includes('大模型调用失败'), fellBackToTemplate, text: failed.slice(-160) })
  }
  else {
    report.steps.push({ state: 'failing', skipped: '本机没有 llm-user.json，无法构造"配置错误"' })
  }
}
finally {
  if (hadConfig && original !== null) writeFileSync(CFG, original, 'utf8')
  report.configRestored = !hadConfig || readFileSync(CFG, 'utf8') === original
  report.backupLeft = existsSync(BAK)
}
await browser.close()
writeFileSync(join(import.meta.dirname, 'probe-ac005-report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log('AC005_STATES ' + JSON.stringify(report.steps.map(step => ({ state: step.state, hit: step.hit, fellBackToTemplate: step.fellBackToTemplate, skipped: step.skipped }))) + ' configRestored=' + report.configRestored)
