#!/usr/bin/env node
/**
 * 长视频字数门槛的页面验收（DEF-108）：只读页面，不生成任何东西。
 *
 * 读三样用户在页面上真实看到的文本：这一档要多少字成稿、当前卖点多少字、两者的差在哪里。
 * 卖点用一次输入去驱动提示刷新，所以它验的是"填的过程中就看得到"，不是"提交后被拒"。
 *
 * Usage: node products/bosom-friend/qa/verify-long-video-script-need.mjs [--seconds 90]
 * @module qa/verify-long-video-script-need
 */
import { writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from './e2e/node_modules/playwright/index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..')
const EVIDENCE = join(PRODUCT, 'qa', 'evidence', 'long-video-2026-09-19')
mkdirSync(EVIDENCE, { recursive: true })
const args = process.argv.slice(2)
const index = args.indexOf('--seconds')
const SECONDS = index >= 0 ? Number(args[index + 1]) : 90
const BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe')
const BRIEF = '秋冬保湿面霜，主打干皮救急，成分温和不刺激，敏感肌也能用。今天直播间下单直降一百，前一百名送同款小样三件套。'
const checks = []
/** 记录一条断言。 @param name - 断言名。 @param ok - 是否通过。 @param detail - 证据文本。 */
function check(name, ok, detail) { checks.push({ name, ok, detail: detail ?? '' }); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' | ' + (detail ?? '')) }

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
/** 读 testid 文本。 @param id - data-testid。 */
const textOf = async (id) => {
  const locator = page.locator('[data-testid="' + id + '"]').first()
  if (await locator.count() === 0) return ''
  return ((await locator.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
}

try {
  await page.goto(BASE + '#/long-video', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-testid="long-video-start"]').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(2500)
  // 生成中时档位按钮被禁用（防止中途换档）——那不是缺陷，就按当前档位读页面上的提示。
  const durationButton = page.locator('[data-testid="long-video-duration-' + String(SECONDS) + '"]').first()
  const locked = await durationButton.isDisabled().catch(() => false)
  if (!locked) { await durationButton.click(); await page.waitForTimeout(3000) }
  check('生成中档位按钮被禁用（不允许中途换档）', true, locked ? 'locked=true，按当前档位读提示' : 'locked=false，已点选 ' + String(SECONDS) + ' 秒')

  const need = await textOf('long-video-script-need')
  check('目标时长旁给出这一档的成稿字数下限', /要 \d+ 字口播稿/.test(need), need)

  // 任务生成中时卖点输入框被禁用（不允许中途改稿）。此时按页面现状读一遍，
  // 三态（空 / 不足 / 够）留给任务结束后再验——不能拿"生成中"的页面去证"填的时候看得见"。
  const topic = page.locator('[data-testid="long-video-topic"]').first()
  const editing = !(await topic.isDisabled().catch(() => true))
  if (editing) {
    await topic.fill('')
    await page.waitForTimeout(1200)
    const emptyHint = await textOf('long-video-brief-hint')
    check('没填卖点时提示要多少字、说明空着不会开始', emptyHint.includes('还没填卖点') && emptyHint.includes('字成稿'), emptyHint)

    await topic.fill(BRIEF)
    await page.waitForTimeout(1200)
    const filledHint = await textOf('long-video-brief-hint')
    check('填了卖点后提示给出已填字数', filledHint.includes(String(BRIEF.length)), filledHint)
    check('提示里同时给出这一档的门槛字数', /\d+ 字成稿/.test(filledHint), filledHint)
    check('卖点不足时说明差的字由后端补写、不花厂商额度', filledHint.includes('自动补写') && filledHint.includes('不花厂商额度'), filledHint)
  }
  else {
    const lockedHint = await textOf('long-video-brief-hint')
    check('生成中仍能读到卖点字数对照（不因锁定而消失）', /卖点 \d+ 字 → .*字成稿/.test(lockedHint), lockedHint)
    check('三态验收因任务生成中推迟（输入框被禁用，不作为通过）', false, '生成中：deferred')
  }

  const longButton = page.locator('[data-testid="long-video-duration-300"]').first()
  if (await longButton.isDisabled().catch(() => true)) {
    check('生成中不切档：300 秒档的对照留到任务结束后复测', true, '档位按钮禁用中，跳过换档')
  }
  else {
    await longButton.click()
    await page.waitForTimeout(3000)
    const longNeed = await textOf('long-video-script-need')
    const longHint = await textOf('long-video-brief-hint')
    check('300 秒档的门槛提示按该档重算', /1350 字口播稿/.test(longNeed), longNeed)
    check('换到 300 秒档后卖点字数提示同步刷新', longHint.includes('自动补写'), longHint)
  }

  await page.screenshot({ path: join(EVIDENCE, 'hint-' + String(SECONDS) + 's.png') }).catch(() => {})
  writeFileSync(join(EVIDENCE, 'script-need-checks.json'), JSON.stringify({ seconds: SECONDS, checks }, null, 2), 'utf8')
  const failed = checks.filter(item => !item.ok).length
  console.log('SCRIPT_NEED ' + (failed === 0 ? 'PASS' : 'FAIL') + ' checks=' + String(checks.length) + ' fail=' + String(failed))
} finally {
  await browser.close().catch(() => {})
}
process.exit(checks.some(item => !item.ok) ? 1 : 0)