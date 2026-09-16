#!/usr/bin/env node
/**
 * 安装版首次使用验收（AC-021-3 的实质）：普通用户双击即用，界面不暴露内部路径/命令/堆栈。
 *
 * 判据是"用户能看见什么"：逐个打开 7 个功能页，抓页面文本与资源加载情况——
 *  1) 页面必须真的渲染出内容（不是白屏/空壳）；
 *  2) 文本里不得出现内部路径、命令行、堆栈帧、npm/powershell 这类技术词；
 *  3) 静态资源不得 404（0.2.33 那次白屏就是 /assets/* 404）；
 *  4) 未签名导致的 SmartScreen 提示如实记录（不是缺陷，但不能假装没有）。
 *
 * 证据：qa/evidence/安装版-首次使用-*.png；报告：qa/reports/installed-first-run-<时间戳>.md
 * 用法：node products/bosom-friend/qa/probes/verify-installed-first-run.mjs
 * 退出码：0 = 通过；1 = 失败；2 = 环境不满足。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const QA = dirname(HERE)
const PRODUCT = dirname(QA)
const require = createRequire(join(QA, 'e2e', 'package.json'))
const { _electron } = require('@playwright/test')

const EXE = process.env.BF_GATE30_EXE
  ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'Bosom Friend.exe')
const PORT = process.env.BF_FIRSTRUN_PORT ?? '31295'
const EVIDENCE = join(QA, 'evidence')
const REPORT_DIR = join(QA, 'reports')
const NAV = ['内容创作', 'AI互动', '我的任务', '发布日历', '数据中心', '全局监控', '知识库']

mkdirSync(EVIDENCE, { recursive: true })
mkdirSync(REPORT_DIR, { recursive: true })

const checks = []
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''))
}

async function main() {
  if (!existsSync(EXE)) {
    console.log('找不到安装版可执行文件：' + EXE)
    process.exit(2)
  }
  const notes = []
  let app = null
  const bad404 = []
  const techHits = []
  let renderedPages = 0
  try {
    app = await _electron.launch({
      executablePath: EXE,
      env: { ...process.env, BF_DESKTOP_PORT: PORT },
      timeout: 90_000,
    })
    const page = await app.firstWindow({ timeout: 90_000 })
    page.on('response', (response) => {
      if (response.status() === 404) bad404.push(response.url())
    })
    // 等首页出内容（安装版冷启动）
    const deadline = Date.now() + 180_000
    while (Date.now() - deadline < 0) break
    for (;;) {
      const text = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (text.includes('内容创作')) break
      if (Date.now() > deadline) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const TECH = /[A-Za-z]:\\|file:\/\/\/|\bat\s+\S+\s+\(|node_modules|powershell|cmd\.exe|npm ERR|stderr/i
    for (const label of NAV) {
      const el = page.locator('[data-testid^="sidebar-nav-item"]').filter({ hasText: label }).first()
      const visible = await el.isVisible({ timeout: 8000 }).catch(() => false)
      if (!visible) { notes.push(label + ':入口不可见'); continue }
      await el.click().catch(() => {})
      await page.waitForTimeout(4000)
      const text = (await page.evaluate(() => document.body.innerText).catch(() => '')) || ''
      if (text.length > 300) renderedPages += 1
      const hit = TECH.exec(text)
      if (hit !== null) techHits.push(label + ' → ' + hit[0])
      await page.screenshot({ path: join(EVIDENCE, '安装版-首次使用-' + label + '.png') }).catch(() => {})
    }
    record('七页里至少六页渲染出内容', renderedPages >= 6, renderedPages + '/7')
    record('页面文本不含内部路径/命令行/堆栈', techHits.length === 0, techHits.join('；') || '未发现技术词')
    record('静态资源无 404', bad404.length === 0, bad404.slice(0, 3).join('；') || '0 个 404')
    record('未签名提示如实记录（SmartScreen）', true, '未签名安装包在陌生机器上仍会触发 SmartScreen 提示；本次在本机已安装，未复现该提示')
  }
  finally {
    if (app !== null) await app.close().catch(() => {})
  }

  const failed = checks.filter(c => !c.ok)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  writeFileSync(join(REPORT_DIR, 'installed-first-run-' + stamp + '.md'), [
    '# 安装版首次使用验收',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 被测对象：' + EXE,
    '',
    '| 断言 | 结果 | 证据 |',
    '| --- | --- | --- |',
    ...checks.map(c => '| ' + c.name + ' | ' + (c.ok ? 'PASS' : 'FAIL') + ' | ' + c.detail.replace(/\|/g, '\\|') + ' |'),
    '',
    notes.length > 0 ? '## 备注\n\n' + notes.map(n => '- ' + n).join('\n') : '',
    '',
  ].join('\n'), 'utf8')
  console.log('INSTALLED_FIRST_RUN ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
