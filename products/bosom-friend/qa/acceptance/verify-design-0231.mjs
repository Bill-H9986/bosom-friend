// 0.2.31 参考设计回归 + 「内容创作平台 = 添加频道平台」对齐检查。
//
// 只从真实前端页面出发（page.goto / page.locator / page.screenshot），
// 不直接请求后端，也不读产品数据根：判定标准就是用户能看到的文字与图标。
// 用法：node products/bosom-friend/qa/acceptance/verify-design-0231.mjs
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const SHOTS = join(import.meta.dirname, 'design-0231')
mkdirSync(SHOTS, { recursive: true })

const results = []
function record(id, name, pass, detail = '') {
  results.push({ id, name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ' :: ' + detail : ''}`)
}

async function agree(page) {
  try {
    const consent = page.locator("button:has-text('我已阅读并同意')").first()
    await consent.click({ timeout: 8000 })
    const enter = page.locator("button:has-text('同意并进入平台')").first()
    await enter.waitFor({ state: 'visible', timeout: 5000 })
    await enter.click({ timeout: 8000 })
    await page.waitForTimeout(2000)
  }
  catch {
    // 已同意过（或本次没有免责声明）：无需处理。
  }
}

/** 读取元素集合的可见文字，去掉空白与空项。 */
async function texts(locator) {
  const list = await locator.allTextContents()
  return list.map(item => item.replace(/\s+/g, ' ').trim()).filter(item => item !== '')
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error)))

try {
  // ---- 1. 内容创作页的目标平台 ----
  await page.goto(BASE + '#/draft-box', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000)
  await agree(page)

  const platformTrigger = page.locator('button', { hasText: /个平台/ }).first()
  await platformTrigger.waitFor({ state: 'visible', timeout: 20000 })
  const triggerText = (await platformTrigger.textContent()) ?? ''
  const creationCount = Number((triggerText.match(/(\d+)\s*个平台/) ?? [])[1] ?? '0')
  await page.screenshot({ path: join(SHOTS, '01-creation-platforms.png') })

  await platformTrigger.click()
  await page.waitForTimeout(1200)
  const creationDialog = page.locator('[role=dialog]', { hasText: '目标平台' }).first()
  await creationDialog.waitFor({ state: 'visible', timeout: 10000 })
  // 平台条目本身没有可读文本（只有图标 + 兄弟节点文字），直接按弹层文字切分：
  // 去掉标题「目标平台」与「取消全选」后剩下的即平台名（当前白名单里的名字都不含空格）。
  const creationPlatforms = (await creationDialog.innerText())
    .replace('目标平台', ' ')
    .replace('取消全选', ' ')
    .split(/\s+/)
    .map(text => text.trim())
    .filter(text => text !== '')
  await page.screenshot({ path: join(SHOTS, '02-creation-platform-popover.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  // ---- 2. 添加频道页的平台 ----
  await page.locator('[data-testid=sidebar-account-entry]').click()
  await page.waitForTimeout(2500)
  const channelDialog = page.locator('[role=dialog]', { hasText: '频道管理' }).first()
  await channelDialog.waitFor({ state: 'visible', timeout: 15000 })
  const CHANNEL_UI_LABELS = new Set(['我的频道', '连接新频道', '添加频道', '刷新全部平台', '新建分组', 'Close', ''])
  const channelPlatforms = (await texts(channelDialog.locator('button')))
    // 侧栏平台条目形如「抖音1」「小红书」，去掉末尾的频道数量后即为平台名。
    .map(text => text.replace(/\s+/g, '').replace(/\d+$/, ''))
    .filter(text => !CHANNEL_UI_LABELS.has(text))
  await page.screenshot({ path: join(SHOTS, '03-channel-manager.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)

  const unique = list => [...new Set(list)].sort()
  const creationSet = unique(creationPlatforms)
  const channelSet = unique(channelPlatforms)
  record(
    'D01',
    '内容创作目标平台与添加频道平台一致',
    creationSet.length > 0 && creationSet.join(',') === channelSet.join(','),
    `创作=${creationSet.join('/')} 频道=${channelSet.join('/')} 触发按钮显示${creationCount}个平台`,
  )
  record('D02', '目标平台数量与选择器计数一致', creationCount === creationPlatforms.length, `按钮=${creationCount} 列表=${creationPlatforms.length}`)

  // ---- 3. 设置 → 自定义大模型 的 0.2.31 版式 ----
  await page.locator('[data-testid=sidebar-user-trigger]').click()
  await page.waitForTimeout(700)
  await page.locator('[data-testid=sidebar-settings-entry] button').click()
  await page.waitForTimeout(1200)
  await page.locator('[data-tab-key=customLlm]').click({ timeout: 8000 })
  await page.waitForTimeout(2500)
  const llmText = (await page.locator('[role=dialog]').last().innerText()).replace(/\s+/g, ' ')
  await page.screenshot({ path: join(SHOTS, '04-settings-llm-top.png') })
  const requiredTexts = ['AI 模型服务', '使用你自己的 AI 钥匙', '注册 Agnes 账号', '去 Agnes AI 国内站领取钥匙', '你的 API Key', '你的模型名称', '自动获取可用模型', '保存并使用我的钥匙', '我的钥匙安全吗']
  const missing = requiredTexts.filter(text => !llmText.includes(text))
  record('D03', '设置→自定义大模型为 0.2.31 版式', missing.length === 0, missing.length === 0 ? requiredTexts.length + ' 项文字齐全' : '缺少：' + missing.join('、'))
  record('D04', '设置页无 DSH 版式残留', !llmText.includes('添加提供方') && !llmText.includes('添加自定义提供方') && !llmText.includes('模型目录'))
  record('D05', '页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
}
catch (error) {
  record('D00', '检查脚本执行完成', false, String(error).slice(0, 300))
}
finally {
  await browser.close()
}

const failed = results.filter(item => !item.pass)
console.log(`DESIGN_0231_GATE ${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${results.length} failed=${failed.length}`)
if (failed.length > 0) {
  for (const item of failed)
    console.log(`  ${item.id} ${item.name}: ${item.detail}`)
  process.exit(1)
}
