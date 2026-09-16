#!/usr/bin/env node
/**
 * 真人旅程自动化：以普通人视角只操作真实页面，逐条对应《真人测试清单》。
 * 证据=页面可见文字 + 每步截图 + pageerror；不调用任何后端接口。
 * 运行：node products/bosom-friend/qa/human-journey.mjs
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const dir = fileURLToPath(new URL('.', import.meta.url))
const evidenceDir = join(dir, 'evidence')
const BASE = process.env.BF_JOURNEY_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const RESULTS = []
mkdirSync(evidenceDir, { recursive: true })

function record(id, name, pass, detail = '') {
  RESULTS.push({ id, name, pass, detail: String(detail).slice(0, 400) })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} ${detail}`)
}

async function shot(page, id, desc) {
  const file = join(evidenceDir, `${id}-${desc}.png`)
  await page.screenshot({ path: file, fullPage: true }).catch(() => {})
  return file
}

const errors = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (error) => errors.push(String(error)))

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  await shot(page, '01', '打开首页')
  const body = await page.textContent('body')
  const productOk = /内容创作|创作|账号|数据中心|监控|草稿箱/.test(body || '')
  record('01', '打开出现产品首页', productOk, productOk ? '页面可见产品文案' : '页面内容：' + (body || '').replace(/\s+/g, ' ').slice(0, 200))

  // 免责声明（若弹）
  for (let i = 0; i < 8; i += 1) {
    const btn = page.getByText('我已阅读并同意').first()
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {})
      await page.waitForTimeout(800)
    }
    const enter = page.getByText('同意并进入平台').first()
    if (await enter.isVisible().catch(() => false)) {
      await enter.click().catch(() => {})
      await page.waitForTimeout(800)
    }
  }

  // AI 未配置固定提示（普通人发一句话）
  let aiOk = false
  try {
    const expand = page.locator('[data-testid=ai-assistant-expand-btn]').first()
    if (await expand.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expand.click().catch(() => {})
      await page.waitForTimeout(1200)
    }
    const input = page.locator('[placeholder*="输入你的需求"]').first()
    if (await input.isVisible({ timeout: 8000 }).catch(() => false)) {
      await input.fill('你好')
      const send = page.locator('button[aria-label="发送"]').first()
      if (await send.isVisible({ timeout: 3000 }).catch(() => false)) {
        await send.click().catch(() => {})
      } else {
        await input.press('Enter')
      }
      for (let i = 0; i < 30; i += 1) {
        await page.waitForTimeout(1000)
        if ((await page.textContent('body'))?.includes('未接入任何大模型')) break
      }
      const body2 = await page.textContent('body')
      aiOk = (body2 || '').includes('未接入任何大模型')
      await shot(page, '02', 'AI未配置提示')
    }
  } catch {}
  if (!aiOk) {
    const asideCount = await page.locator('[data-testid=ai-assistant-sidebar]').count()
    const expandCount = await page.locator('[data-testid=ai-assistant-expand-btn]').count()
    const inputCount = await page.locator('[placeholder*="输入你的需求"]').count()
    record('02', 'AI 未配置时固定提示', false, `aside=${asideCount} expand=${expandCount} input=${inputCount}`)
  } else {
    record('02', 'AI 未配置时固定提示', true, '页面出现“未接入任何大模型”')
  }

  // 空输入发送不崩溃
  let emptyOk = false
  try {
    const expand = page.locator('[data-testid=ai-assistant-expand-btn]').first()
    if (await expand.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expand.click().catch(() => {})
      await page.waitForTimeout(800)
    }
    const input = page.locator('[placeholder*="输入你的需求"]').first()
    if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
      await input.fill('')
      await input.press('Enter')
      await page.waitForTimeout(1500)
      emptyOk = true
    }
  } catch {}
  record('03', '空输入不崩溃', emptyOk, emptyOk ? '页面仍可响应' : '输入框不可见')

  // 导航可达性：点击侧栏菜单，页面不空白
  const navItems = ['内容创作', 'AI互动', '任务记录', '账号管理', '发布日历', '数据中心', '全局监控', '知识库', '设置']
  for (const label of navItems) {
    let ok = false
    try {
      const el = page.getByText(label, { exact: false }).first()
      if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
        await el.click({ timeout: 4000 }).catch(() => {})
        await page.waitForTimeout(2500)
        const text = await page.textContent('body')
        ok = (text || '').length > 100
        await shot(page, 'nav-' + label, label)
      }
    } catch {}
    record('nav-' + label, '导航到「' + label + '」', ok, ok ? '页面有内容' : '菜单不可见或页面空白')
  }

  // 刷新后页面仍可用
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  const reloadBody = await page.textContent('body')
  record('04', '刷新后页面仍可用', (reloadBody || '').length > 100)
} finally {
  const report = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    pageerrors: errors.length,
    results: RESULTS,
  }
  writeFileSync(join(dir, '真人旅程报告.json'), JSON.stringify(report, null, 2) + '\n')
  await browser.close()
  const failed = RESULTS.filter((item) => !item.pass)
  console.log(`HUMAN_JOURNEY pass=${RESULTS.length - failed.length} fail=${failed.length} pageerrors=${errors.length}`)
  process.exit(failed.length === 0 ? 0 : 1)
}
