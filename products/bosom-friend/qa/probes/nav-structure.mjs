#!/usr/bin/env node
/** 只读诊断：列出桌面窗口导航结构中「任务记录」「账号管理」的候选元素。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const exe = process.env.BF_DESKTOP_EXE || join(repoRoot, 'products', 'bosom-friend', 'project', 'bosom-friend-electron', 'node_modules', 'electron', 'dist', 'electron.exe')
const desktopDir = join(repoRoot, 'products', 'bosom-friend', 'desktop')
const app = await electron.launch({
  executablePath: exe,
  args: process.env.BF_DESKTOP_EXE ? [] : [desktopDir],
  cwd: desktopDir,
})
try {
  const page = await app.firstWindow()
  await page.waitForTimeout(8000)
  for (const label of ['任务记录', '账号管理']) {
    const loc = page.getByText(label, { exact: true })
    const count = await loc.count()
    console.log(`== ${label} count=${count}`)
    for (let i = 0; i < count; i += 1) {
      const el = loc.nth(i)
      const info = await el.evaluate((node) => {
        const r = node.getBoundingClientRect()
        let a = node.closest('a')
        return {
          tag: node.tagName,
          text: (node.textContent || '').trim().slice(0, 40),
          cls: (node.className || '').toString().slice(0, 80),
          visible: r.width > 0 && r.height > 0,
          rect: `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`,
          href: a ? a.getAttribute('href') : null,
          parentCls: (node.parentElement?.className || '').toString().slice(0, 80),
        }
      }).catch(() => ({ evaluate: 'failed' }))
      console.log(`  [${i}]`, JSON.stringify(info))
    }
  }
  const sidebar = await page.evaluate(() => {
    const candidates = ['nav', 'aside']
    for (const sel of candidates) {
      const el = document.querySelector(sel)
      if (el && el.getBoundingClientRect().height > 100) {
        return { sel, text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 600) }
      }
    }
    return null
  })
  console.log('== SIDEBAR', JSON.stringify(sidebar))
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href],button'))
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el) => ({ tag: el.tagName, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30), href: el.getAttribute('href') || '' }))
    .filter((el) => /任务|账号|设置|我的|发布|知识|监控|数据|创作|互动/.test(el.text))
    .slice(0, 60))
  console.log('== INTERACTIVE', JSON.stringify(links, null, 1))
  const ai = await page.evaluate(() => ({
    testids: Array.from(document.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')).slice(0, 60),
    placeholders: Array.from(document.querySelectorAll('input,textarea')).map((el) => el.getAttribute('placeholder')).filter(Boolean).slice(0, 20),
    ariaLabels: Array.from(document.querySelectorAll('button[aria-label]')).map((el) => el.getAttribute('aria-label')).filter(Boolean).slice(0, 30),
  }))
  console.log('== AI', JSON.stringify(ai, null, 1))
  const vis = await page.evaluate(() => {
    const info = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        rect: `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`,
        display: cs.display,
        visibility: cs.visibility,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      }
    }
    return {
      aiSidebar: info('[data-testid=ai-assistant-sidebar]'),
      aiInput: info('[placeholder*="输入你的需求"]'),
      accountEntry: info('[data-testid=sidebar-account-entry]'),
      userTrigger: info('[data-testid=sidebar-user-trigger]'),
      settings: Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && (el.textContent || '').trim() === '设置').map((el) => {
        const r = el.getBoundingClientRect()
        return `${el.tagName} visible=${r.width > 0 && r.height > 0}`
      }),
    }
  })
  console.log('== VIS', JSON.stringify(vis, null, 1))
  // 真实发送一句话，观察未配置模型时用户可见的回复
  const input = page.locator('[placeholder*="输入你的需求"]').first()
  await input.fill('你好')
  await page.locator('button[aria-label="发送"]').first().click()
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(1000)
    const text = await page.locator('[data-testid=ai-assistant-sidebar]').textContent().catch(() => '')
    console.log(`t${i + 1}: ` + (text || '').replace(/\s+/g, ' ').slice(-400))
  }
  // 空输入发送：观察是否有提示、是否禁用发送
  await input.fill('')
  const disabledBefore = await page.locator('button[aria-label="发送"]').first().isDisabled().catch(() => null)
  await input.press('Enter')
  await page.waitForTimeout(1500)
  const disabledAfter = await page.locator('button[aria-label="发送"]').first().isDisabled().catch(() => null)
  const afterEmpty = await page.locator('[data-testid=ai-assistant-sidebar]').textContent().catch(() => '')
  console.log('EMPTY_SEND disabledBefore=' + disabledBefore + ' disabledAfter=' + disabledAfter)
  console.log('EMPTY_SEND tail=' + (afterEmpty || '').replace(/\s+/g, ' ').slice(-250))
} finally {
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200))
  } catch {}
  await app.close().catch(() => {})
}
