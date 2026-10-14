#!/usr/bin/env node
/**
 * 长视频任务的只读现状快照：打开产品页读一次进度面板，供外部判断任务是否还在推进。
 *
 * 不点任何控件、不下单、不改数据；只截图 + 读页面可见文本。
 *
 * Usage: node products/bosom-friend/qa/probes/long-video-status-snapshot.mjs
 * @module qa/probes/long-video-status-snapshot
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'long-video-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
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
  await page.waitForTimeout(6000)
  const progress = await textOf('long-video-progress')
  const elapsed = await textOf('long-video-elapsed')
  const eta = await textOf('long-video-eta')
  const result = await textOf('long-video-result')
  const errorText = await textOf('long-video-error')
  const items = page.locator('[data-testid="long-video-shots"] li')
  const total = await items.count()
  let ready = 0
  const rows = []
  for (let i = 0; i < total; i += 1) {
    const text = ((await items.nth(i).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    rows.push(text.slice(0, 80))
    if (/已生成/.test(text)) ready += 1
  }
  const snapshot = { at: new Date().toISOString(), progress, elapsed, eta, result, errorText, shotsTotal: total, shotsReady: ready, shots: rows }
  writeFileSync(join(EVIDENCE, 'status-snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8')
  await page.screenshot({ path: join(EVIDENCE, 'status-' + snapshot.at.slice(11, 16).replace(':', '') + '.png') }).catch(() => {})
  console.log(JSON.stringify({ progress, elapsed, eta, result, errorText, shotsReady: ready, shotsTotal: total }))
} finally {
  await browser.close().catch(() => {})
}
