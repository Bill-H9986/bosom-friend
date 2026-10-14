#!/usr/bin/env node
/**
 * 内容创作终态只读归档：读页面上最新那条生成记录的可见状态，并把成片的真实规格记下来。
 *
 * 页面层：记录卡上的状态词（生成中 / 生成成功 / 生成失败）、标题、模型名、参数药丸。
 * 文件层（诊断）：成片文件用 ffmpeg 只读元数据，核对真实时长与像素。
 *
 * Usage: node products/bosom-friend/qa/probes/content-generation-final-state.mjs [--out <文件名>]
 * @module qa/probes/content-generation-final-state
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const args = process.argv.slice(2)
const dirIndex = args.indexOf('--dir')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', dirIndex >= 0 ? String(args[dirIndex + 1]) : 'content-duration-params-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
const outIndex = args.indexOf('--out')
const OUT = join(EVIDENCE, (outIndex >= 0 ? String(args[outIndex + 1]) : 'final-state') + '.json')
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  await page.goto('http://127.0.0.1:31280/bosom-friend/#/draft-box', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(6000)
  const cards = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('div,li,article'))
      .filter(el => /生成成功|生成中|生成失败|部分成功/.test(el.textContent ?? '') && (el.textContent ?? '').length < 400)
      .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
    return [...new Set(rows)].slice(0, 6)
  })
  const pills = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="draftbox-ai-"]'))
    .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 20))
  const newest = JSON.parse(readFileSync(join(homedir(), '.bosom-friend', 'bosom-friend', 'draft-generations.json'), 'utf8')).value?.[0] ?? {}
  const url = String(newest.response?.videoUrl ?? '')
  const file = url === '' ? '' : join(homedir(), '.bosom-friend', 'bosom-friend', 'uploads', url.split('/').pop() ?? '')
  const snapshot = {
    at: new Date().toISOString(),
    pageCards: cards,
    toolbarPills: pills,
    record: { id: newest.id, status: newest.status, requestDuration: newest.request?.duration, aspectRatio: newest.request?.aspectRatio, resolution: newest.request?.resolution, errorMessage: newest.errorMessage ?? '' },
    videoUrl: url,
    videoFile: file,
    videoExists: file !== '' && existsSync(file),
  }
  if (snapshot.videoExists) {
    const probe = spawnSync(join(PRODUCT, 'desktop', 'dist', 'runtime', 'ffmpeg.exe'), ['-hide_banner', '-i', file], { encoding: 'utf8' })
    snapshot.ffprobe = String(probe.stderr ?? '').split('\n').filter(line => /Duration|Stream #/.test(line)).join(' | ').trim()
  }
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2), 'utf8')
  await page.screenshot({ path: join(EVIDENCE, '99-终态-' + (outIndex >= 0 ? String(args[outIndex + 1]) : 'final-state') + '.png') }).catch(() => {})
  console.log(JSON.stringify({ pills: pills.slice(0, 8), record: snapshot.record, videoUrl: url, ffprobe: snapshot.ffprobe ?? '' }).slice(0, 1200))
} finally {
  await browser.close().catch(() => {})
}
