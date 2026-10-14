#!/usr/bin/env node
/**
 * 长视频终态只读归档：任务跑完后把页面上的终态、分镜清单、成片地址与成片真实规格存一份。
 *
 * 只读：打开页面、读可见文本、读 video 元素的真实 src；ffmpeg 只读成片文件元数据。
 * Usage: node products/bosom-friend/qa/probes/long-video-final-state.mjs [--suffix resume]
 * @module qa/probes/long-video-final-state
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'long-video-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
const args = process.argv.slice(2)
const suffixIndex = args.indexOf('--suffix')
const SUFFIX = suffixIndex >= 0 ? String(args[suffixIndex + 1]) : 'final'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
/** 读 testid 文本。 @param id - data-testid。 */
const textOf = async (id) => {
  const locator = page.locator('[data-testid="' + id + '"]').first()
  if (await locator.count() === 0) return ''
  return ((await locator.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
}
try {
  await page.goto('http://127.0.0.1:31280/bosom-friend/#/long-video', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="long-video-progress"], [data-testid="long-video-start"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(8000)
  const items = page.locator('[data-testid="long-video-shots"] li')
  const total = await items.count()
  const rows = []
  for (let i = 0; i < total; i += 1) rows.push(((await items.nth(i).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim())
  // data-testid="long-video-result" 挂在 <video> 元素**本身**上（不是包一层 div）：
  // 之前按 "[data-testid=...] video" 去找子元素，读到的永远是空，成片地址因此丢过一次。
  const videoSrc = await page.locator('video[data-testid="long-video-result"]').first().getAttribute('src').catch(() => '')
    ?? await page.locator('[data-testid="long-video-result"]').first().getAttribute('src').catch(() => '')
    ?? ''
  const snapshot = {
    at: new Date().toISOString(),
    progress: await textOf('long-video-progress'),
    elapsed: await textOf('long-video-elapsed'),
    resultVisible: await page.locator('[data-testid="long-video-result"]').count() > 0,
    errorText: await textOf('long-video-error'),
    shotsTotal: total,
    shotsReady: rows.filter(text => !/等待中/.test(text)).length,
    shots: rows,
    videoSrc,
  }
  if (videoSrc !== '') {
    const file = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend', 'uploads', videoSrc.split('/').pop() ?? '')
    snapshot.videoFile = file
    snapshot.videoExists = existsSync(file)
    if (snapshot.videoExists) {
      const probe = spawnSync(join(PRODUCT, 'desktop', 'dist', 'runtime', 'ffmpeg.exe'), ['-hide_banner', '-i', file], { encoding: 'utf8' })
      snapshot.ffprobe = String(probe.stderr ?? '').split('\n').filter(line => /Duration|Stream #/.test(line)).join(' | ').trim()
    }
  }
  writeFileSync(join(EVIDENCE, 'final-state-' + SUFFIX + '.json'), JSON.stringify(snapshot, null, 2), 'utf8')
  await page.screenshot({ path: join(EVIDENCE, '99-终态-' + SUFFIX + '.png') }).catch(() => {})
  console.log(JSON.stringify({ progress: snapshot.progress, shotsReady: snapshot.shotsReady, shotsTotal: snapshot.shotsTotal, videoSrc: snapshot.videoSrc, ffprobe: snapshot.ffprobe ?? '' }).slice(0, 1200))
} finally {
  await browser.close().catch(() => {})
}
