import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadChromium } from '../products/bosom-friend/qa/browser.mjs'

const outDir = process.argv[2]
const repo = process.argv[3]
mkdirSync(outDir, { recursive: true })
const base = 'http://127.0.0.1:31280/bosom-friend/'
const chromium = loadChromium()
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const log = []

// 1) 启动页：直接用产品自带的启动页渲染器（desktop/renderer），喂给它主进程真实上报的字段。
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN' })
  const page = await ctx.newPage()
  const url = pathToFileURL(join(repo, 'products/bosom-friend/desktop/renderer/index.html')).href
  await page.goto(url, { waitUntil: 'load' })
  await page.evaluate(() => {
    document.querySelector('[data-role="version"]').textContent = 'v0.2.54'
    window.renderProgress({
      label: '校验内核运行时',
      percent: 12,
      indeterminate: true,
      detail: '正在解压内置运行时 158432/195539（首次启动会慢一些）',
    })
    document.querySelector('[data-role="elapsed"]').textContent = '已用时 87 秒'
  })
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(outDir, '00-splash.png') })
  console.log('captured 00-splash')
  await ctx.close()
}

// 2) 长视频创作：滚到分镜列表（滚动容器在页面内部，window 滚不动）。
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' })
  const page = await ctx.newPage()
  await page.goto(base + '#/long-video', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  const scrolled = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'))
    const target = els.filter(el => el.scrollHeight - el.clientHeight > 400 && el.clientHeight > 400)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
    if (!target) return null
    target.scrollTop = Math.round(target.clientHeight * 1.05)
    return { tag: target.tagName, cls: String(target.className).slice(0, 60), scrollTop: target.scrollTop, h: target.scrollHeight }
  })
  log.push('scroll: ' + JSON.stringify(scrolled))
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(outDir, '26-longvideo-storyboard.png') })
  console.log('captured 26-longvideo-storyboard')
  await ctx.close()
}

console.log('LOG: ' + JSON.stringify(log))
await browser.close()
