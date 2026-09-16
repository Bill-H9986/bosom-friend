#!/usr/bin/env node
/**
 * 启动页进度条验收（两种真实场景，都用真进程）。
 *
 * 场景 A（attach，默认）：预启动真实产品服务 → 桌面壳命中"接入既有服务"分支。
 *   这条路径很快，肉眼几乎看不到启动页，因此断言读的是**主进程留痕**（status.progressLog）：
 *   每一步里程碑、百分比、模式都来自真实上报，不依赖采样时机。
 * 场景 B（cold，--cold）：端口上没有服务，内核握手人为收紧到 15 秒 → 必须给出可读失败原因。
 *   这条路径启动页会停留足够久，采样真实 DOM，同时截图留证。
 *
 * 两个场景共同钉住进度语义：百分比单调不减、不确定态不推进、阶段真的换过、失败必须说清原因。
 * 证据：qa/evidence/启动页-进度条-*.png；报告：qa/reports/splash-progress-<时间戳>.md
 *
 * 场景 C（packaged，--packaged）：直接启动**安装好的应用**（默认端口让开，逼它走冷启动），
 *   断言真实安装包里的启动页同样有进度条、阶段按序推进并最终进入产品页——
 *   这是"交给用户的那份东西真的有进度条"的证据。
 *
 * 用法：
 *   node products/bosom-friend/qa/probes/verify-splash-progress.mjs            # 只跑场景 A
 *   node products/bosom-friend/qa/probes/verify-splash-progress.mjs --cold     # 只跑场景 B
 *   node products/bosom-friend/qa/probes/verify-splash-progress.mjs --packaged # 只跑场景 C
 *   node products/bosom-friend/qa/probes/verify-splash-progress.mjs --both
 * 退出码：0 = 全部通过；1 = 存在失败断言；2 = 环境不满足。
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const QA = dirname(HERE)
const PRODUCT = dirname(QA)
const repoRoot = dirname(dirname(PRODUCT))
const require = createRequire(join(QA, 'e2e', 'package.json'))
const { _electron } = require('@playwright/test')

const ELECTRON = process.env.BF_ELECTRON_EXE
  ?? join(PRODUCT, 'project', 'bosom-friend-electron', 'node_modules', 'electron', 'dist', 'electron.exe')
const DESKTOP_DIR = join(PRODUCT, 'desktop')
// 入口是构建产物 lib/bin-desktop.mjs（旧路径 lib/types/bin.js 随 src/bin.ts 一起没了；
// 构建：pnpm --filter @deepseek-ai/bosom-friend build:desktop）。
// 开发态与随包版同源：入口是 bundle/kernel/runtime（三层 bundle 补丁里的插件是裸包名，
// Node 按配置文件所在目录解析，只有 bundle/kernel 声明了完整插件闭包；见 DEF-059）。
const SERVER_BIN = join(PRODUCT, 'bundle', 'kernel', 'runtime', 'bin-desktop.mjs')
const FRONTEND_DIST = join(PRODUCT, 'project', 'bosom-friend-electron', 'dist')
const EVIDENCE = join(QA, 'evidence')
const REPORT_DIR = join(QA, 'reports')
const PERF = process.env.BF_PERF_PROFILE ?? ''
const MODE = process.argv.includes('--cold')
  ? 'cold'
  : process.argv.includes('--packaged')
    ? 'packaged'
    : process.argv.includes('--both') ? 'both' : 'attach'
const PACKAGED_EXE = process.env.BF_GATE30_EXE
  ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'Bosom Friend.exe')

mkdirSync(EVIDENCE, { recursive: true })
mkdirSync(REPORT_DIR, { recursive: true })

const checks = []
const record = (scenario, name, ok, detail = '') => {
  checks.push({ scenario, name, ok, skipped: false, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + '[' + scenario + '] ' + name + (detail ? ' | ' + detail : ''))
}
/**
 * 记录一条**不适用**的断言：环境里根本没发生那个分支。
 * 不适用既不算通过也不算失败——按项目铁律「SKIP ≠ PASS」，这里单独成一类并计入 skipped。
 * @param scenario - 场景编号（A/B/C）。
 * @param name - 断言名。
 * @param detail - 为什么不适用。
 */
const skip = (scenario, name, detail = '') => {
  checks.push({ scenario, name, ok: true, skipped: true, detail })
  console.log('SKIP [' + scenario + '] ' + name + (detail ? ' | ' + detail : ''))
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const baseFor = port => 'http://127.0.0.1:' + port + '/bosom-friend/'

async function isServing(port) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const response = await fetch(baseFor(port), { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  }
  catch {
    return false
  }
}

function killTree(child) {
  if (child === null || child === undefined || child.exitCode !== null) return
  try {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
  catch {
    // 已经退出就不用杀
  }
}

/** 起一个真实产品服务（隔离数据根，绝不动用户真实数据）。 */
async function startProductServer(port, home) {
  if (await isServing(port)) return { child: null, reused: true }
  const child = spawn(process.execPath, [SERVER_BIN, '--port', String(port), '--no-open'], {
    env: { ...process.env, BOSOM_FRIEND_HOME: home, BF_FRONTEND_DIST: FRONTEND_DIST, BF_DESKTOP_PORT: String(port) },
    stdio: 'ignore',
    windowsHide: true,
  })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (await isServing(port)) return { child, reused: false }
    if (child.exitCode !== null) return { child, reused: false, exited: child.exitCode }
    await sleep(1000)
  }
  return { child, reused: false, timedOut: true }
}

/** 采样启动页 DOM；产品页接管（没有进度条元素）时返回 `null`。 */
async function sample(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-role="progressbar"]')
    if (bar === null) return null
    const wrap = document.querySelector('[data-role="progress"]')
    const tier = document.querySelector('[data-role="tier"]')
    const problem = document.querySelector('[data-role="problem"]')
    const actions = document.querySelector('[data-role="actions"]')
    return {
      now: Number(bar.getAttribute('aria-valuenow')),
      role: bar.getAttribute('role'),
      mode: wrap === null ? '' : wrap.getAttribute('data-mode'),
      stage: document.querySelector('[data-role="progress-stage"]')?.textContent ?? '',
      detail: document.querySelector('[data-role="progress-detail"]')?.textContent ?? '',
      elapsed: document.querySelector('[data-role="elapsed"]')?.textContent ?? '',
      percentText: document.querySelector('[data-role="progress-percent"]')?.textContent ?? '',
      fillWidth: document.querySelector('[data-role="progress-fill"]')?.style.width ?? '',
      tier: tier === null || tier.getAttribute('data-open') !== 'true' ? '' : tier.textContent ?? '',
      problem: problem === null || problem.getAttribute('data-open') !== 'true' ? '' : problem.textContent ?? '',
      actionsOpen: actions !== null && actions.getAttribute('data-open') === 'true',
    }
  }).catch(() => null)
}

/** 场景 A：接入既有服务，进度必须走完并加载产品页（读主进程留痕，不靠采样时机）。 */
async function scenarioAttach(port) {
  const home = mkdtempSync(join(tmpdir(), 'bf-splash-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'bf-splash-userdata-'))
  let app = null
  let server = { child: null, reused: false }
  let status = null
  let enteredProduct = false
  let splashShot = false
  try {
    server = await startProductServer(port, home)
    if (server.timedOut === true) {
      record('A', '产品服务在 180 秒内就绪', false, '服务未就绪，无法验收')
      return
    }
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP_DIR, '--user-data-dir=' + userData],
      env: { ...process.env, BF_DESKTOP_PORT: String(port), BOSOM_FRIEND_HOME: home, BF_FRONTEND_DIST: FRONTEND_DIST, ...(PERF === '' ? {} : { BF_PERF_PROFILE: PERF }) },
      timeout: 60_000,
    })
    const page = await app.firstWindow({ timeout: 60_000 })
    const startedAt = Date.now()
    while (Date.now() - startedAt < 60_000) {
      const text = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (text.includes('内容创作')) { enteredProduct = true; break }
      const state = await sample(page)
      if (state !== null && !splashShot) {
        splashShot = true
        await page.screenshot({ path: join(EVIDENCE, '启动页-进度条-启动中.png') }).catch(() => {})
      }
      await sleep(100)
    }
    if (enteredProduct) {
      status = await page.evaluate(() => window.bosomKernel?.getStatus?.() ?? null).catch(() => null)
      await page.screenshot({ path: join(EVIDENCE, '启动页-进度条-进入产品页.png') }).catch(() => {})
    }
    record('A', '接入既有服务后进入产品页', enteredProduct, enteredProduct ? '已进入' : '60 秒内未进入产品页')
    const log = Array.isArray(status?.progressLog) ? status.progressLog : []
    record('A', '主进程留痕记录了启动里程碑（≥2 步）', log.length >= 2, log.map(l => l.label + ' ' + l.percent + '%').join(' → ') || '（无留痕）')
    const regress = log.filter((l, i) => i > 0 && l.percent < log[i - 1].percent)
    record('A', '留痕里百分比单调不减', regress.length === 0, regress.length === 0 ? '最大 ' + (log.at(-1)?.percent ?? 0) + '%' : JSON.stringify(regress))
    record('A', '进度走到 100% 并停在同一界面阶段', log.at(-1)?.percent === 100 && log.at(-1)?.stage === 'ui', JSON.stringify(log.at(-1) ?? {}))
    record('A', '接入路径没有报错', (status?.error ?? '') === '', status?.error ?? '')
    if (PERF === 'low') {
      record('A', '低配档位被如实识别', status?.perf?.tier === 'low', JSON.stringify(status?.perf?.reasons ?? []))
    }
  }
  finally {
    if (app !== null) await app.close().catch(() => {})
    if (server.reused === false) killTree(server.child)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** 场景 B：端口上没有服务且内核不回应 → 启动页必须给出可读失败原因，不许无限等待。 */
async function scenarioCold(port) {
  const home = mkdtempSync(join(tmpdir(), 'bf-splash-home-'))
  const userData = mkdtempSync(join(tmpdir(), 'bf-splash-userdata-'))
  const samples = []
  let app = null
  let failedText = ''
  try {
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP_DIR, '--user-data-dir=' + userData],
      env: {
        ...process.env,
        BF_DESKTOP_PORT: String(port),
        BOSOM_FRIEND_HOME: home,
        BF_FRONTEND_DIST: FRONTEND_DIST,
        BF_KERNEL_HANDSHAKE_TIMEOUT_MS: '15000',
        BF_STARTUP_WAIT_SECONDS: '15',
        ...(PERF === '' ? {} : { BF_PERF_PROFILE: PERF }),
      },
      timeout: 60_000,
    })
    const page = await app.firstWindow({ timeout: 60_000 })
    const startedAt = Date.now()
    let shotProgress = false
    let misses = 0
    while (Date.now() - startedAt < 90_000) {
      const state = await sample(page)
      if (state !== null) {
        misses = 0
        samples.push({ at: Date.now() - startedAt, ...state })
        if (!shotProgress && state.now > 0) {
          shotProgress = true
          await page.screenshot({ path: join(EVIDENCE, '启动页-进度条-启动中.png') }).catch(() => {})
        }
        if (state.problem !== '') { failedText = state.problem; break }
      } else {
        // 进度条消失：可能是进了产品页（冷启动自己拉起内核成功），也可能是页面挂了。
        // 连续几次都取不到进度条时确认一下，别让采样空转到 90 秒。
        misses += 1
        if (misses >= 5 && await page.evaluate(() => document.body.innerText.includes('内容创作')).catch(() => false)) break
      }
      await sleep(150)
    }
    if (failedText !== '') await page.screenshot({ path: join(EVIDENCE, '启动页-进度条-失败态.png') }).catch(() => {})
    // 端口隔离修好之后（DEF-060），「端口上没有服务」会让应用**自己**把内核拉起来并进入产品页——
    // 那是期望行为，这时失败分支的三条断言不适用：按项目铁律「SKIP ≠ PASS」单独记一类，不冒充通过。
    const enteredProduct = await page.evaluate(() => document.body.innerText.includes('内容创作')).catch(() => false)
    const status = enteredProduct
      ? await page.evaluate(() => window.bosomKernel?.getStatus?.() ?? null).catch(() => null)
      : null
    const progressLog = Array.isArray(status?.progressLog) ? status.progressLog : []
    if (enteredProduct) {
      record('B', '冷启动：没有既有服务时自己拉起内核并进入产品页', true,
        progressLog.map(l => l.label + ' ' + l.percent + '%').join(' → ').slice(0, 140))
      await page.screenshot({ path: join(EVIDENCE, '启动页-进度条-冷启动进入产品页.png') }).catch(() => {})
    }
    record('B', '启动页在失败前一直显示进度条', samples.length > 0, '采样 ' + samples.length + ' 次')
    const regress = samples.filter((s, i) => i > 0 && s.now < samples[i - 1].now)
    record('B', '百分比单调不减', regress.length === 0, '最大 ' + Math.max(0, ...samples.map(s => s.now)) + '%')
    const fake = samples.filter((s, i) => i > 0 && samples[i - 1].mode === 'indeterminate' && samples[i - 1].stage === s.stage && s.now > samples[i - 1].now)
    record('B', '不确定态下百分比不推进', fake.length === 0, fake.length === 0 ? '未发现按时间爬升' : fake.map(f => f.stage + ':' + f.now).join('、'))
    const stages = enteredProduct
      ? [...new Set(progressLog.map(l => l.label).filter(l => l !== ''))]
      : [...new Set(samples.map(s => s.stage).filter(s => s !== ''))]
    record('B', '阶段文案逐个推进（≥2 个不同阶段）', stages.length >= 2, stages.join(' → '))
    if (enteredProduct) {
      skip('B', '显示已用时', '启动页 ' + Math.max(1, Math.round((samples.at(-1)?.at ?? 0) / 1000)) + ' 秒内就进了产品页，没走到显示已用时的阶段')
    } else {
      record('B', '显示已用时', samples.some(s => s.elapsed !== ''), samples.at(-1)?.elapsed ?? '（未出现）')
    }
    // 显示诚实性：文字百分比必须等于 aria 值；填充长度不得超过真实进度（不许满格冒充）。
    const textMismatch = samples.filter(s => s.percentText !== s.now + '%')
    record('B', '百分比文字与可访问值一致', textMismatch.length === 0,
      textMismatch.length === 0 ? '全部一致' : textMismatch.slice(0, 3).map(s => s.now + '% vs ' + s.percentText).join('、'))
    const overfill = samples.filter(s => Number.parseFloat(s.fillWidth || '0') > s.now + 0.5)
    record('B', '填充长度不超过真实进度', overfill.length === 0,
      overfill.length === 0 ? '最大 ' + samples.at(-1)?.fillWidth : overfill.slice(0, 3).map(s => s.fillWidth + '@' + s.now + '%').join('、'))
    if (enteredProduct) {
      skip('B', '内核不回应时给出可读原因', '应用冷启动成功，未走失败分支')
      skip('B', '失败后提供重试与退出', '应用冷启动成功，未走失败分支')
    } else {
      record('B', '内核不回应时给出可读原因', failedText !== '', failedText.slice(0, 80))
      record('B', '失败后提供重试与退出', samples.at(-1)?.actionsOpen === true, 'actionsOpen=' + String(samples.at(-1)?.actionsOpen))
    }
    if (PERF === 'low') {
      record('B', '低配档位在启动页如实说明', samples.some(s => s.tier.includes('低配模式')), samples.find(s => s.tier !== '')?.tier ?? '（未出现）')
    }
    return samples
  }
  finally {
    if (app !== null) await app.close().catch(() => {})
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** 场景 C：安装好的应用冷启动（真机证据：用户拿到的那份东西确实有进度条）。 */
async function scenarioPackaged(port) {
  const home = mkdtempSync(join(tmpdir(), 'bf-pkg-home-'))
  const samples = []
  let app = null
  let enteredProduct = false
  let splashText = ''
  let status = null
  try {
    // 不能改 --user-data-dir：安装器把内核运行时解压到固定 userData 目录
    // （%APPDATA%\Bosom Friend\kernel-runtime），挪走 userData 等于让应用找不到它，
    // 测出来的就是"内核运行时缺失"而不是启动页本身。产品数据根仍用 BOSOM_FRIEND_HOME 隔离。
    app = await _electron.launch({
      executablePath: PACKAGED_EXE,
      // 让开默认端口：既有服务在 31280 上时应用会走"接入"快路径，就看不到冷启动启动页了。
      env: { ...process.env, BF_DESKTOP_PORT: String(port), BOSOM_FRIEND_HOME: home },
      timeout: 90_000,
    })
    const page = await app.firstWindow({ timeout: 90_000 })
    const startedAt = Date.now()
    let shot = false
    while (Date.now() - startedAt < 180_000) {
      const text = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (text.includes('内容创作')) { enteredProduct = true; break }
      const state = await sample(page)
      if (state !== null) {
        samples.push({ at: Date.now() - startedAt, ...state })
        if (!shot && state.now > 0) {
          shot = true
          await page.screenshot({ path: join(EVIDENCE, '启动页-进度条-安装版启动中.png') }).catch(() => {})
        }
      }
      await sleep(150)
    }
    splashText = await page.evaluate(() => document.body.innerText).catch(() => '')
    if (enteredProduct) {
      // 快机器上启动页只亮几秒，早段阶段会在第一次采样前就跑完；阶段序列改从主进程留痕取，
      // DOM 采样只负责"进度条真的出现过、百分比与显示诚实"。（产品页同样挂着 preload 桥。）
      status = await page.evaluate(() => window.bosomKernel?.getStatus?.() ?? null).catch(() => null)
      await page.screenshot({ path: join(EVIDENCE, '启动页-进度条-安装版进入产品页.png') }).catch(() => {})
    }
  }
  finally {
    if (app !== null) await app.close().catch(() => {})
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  record('C', '安装版启动页出现进度条', samples.length > 0, '采样 ' + samples.length + ' 次' + (samples.length === 0 ? '；启动页文本：' + splashText.slice(0, 100).replace(/\s+/g, ' ') : ''))
  if (samples.length > 0) {
    const regress = samples.filter((s, i) => i > 0 && s.now < samples[i - 1].now)
    record('C', '安装版百分比单调不减', regress.length === 0, '最大 ' + Math.max(...samples.map(s => s.now)) + '%')
    // 阶段序列以主进程留痕为准（快机器上早段阶段会在首次采样前跑完），
    // DOM 采样只负责"进度条真的出现过、显示诚实"。
    const log = Array.isArray(status?.progressLog) ? status.progressLog : []
    record('C', '安装版阶段逐个推进（留痕 ≥2 步）', log.length >= 2, log.map(l => l.label + ' ' + l.percent + '%').join(' → ') || '（无留痕）')
    const logRegress = log.filter((l, i) => i > 0 && l.percent < log[i - 1].percent)
    record('C', '安装版留痕百分比单调不减', logRegress.length === 0, logRegress.length === 0 ? '最大 ' + (log.at(-1)?.percent ?? 0) + '%' : JSON.stringify(logRegress))
    record('C', '安装版留痕走到 100%', log.at(-1)?.percent === 100, JSON.stringify(log.at(-1) ?? {}))
    const fake = samples.filter((s, i) => i > 0 && samples[i - 1].mode === 'indeterminate' && samples[i - 1].stage === s.stage && s.now > samples[i - 1].now)
    record('C', '安装版不确定态不推进百分比', fake.length === 0, fake.length === 0 ? '未发现按时间爬升' : fake.map(f => f.stage + ':' + f.now).join('、'))
    const mismatch = samples.filter(s => s.percentText !== s.now + '%')
    record('C', '安装版百分比文字与可访问值一致', mismatch.length === 0, mismatch.length === 0 ? '全部一致' : mismatch.slice(0, 3).map(s => s.now + ' vs ' + s.percentText).join('、'))
  }
  record('C', '安装版最终进入产品页', enteredProduct, enteredProduct ? '已进入产品页' : '启动页文本：' + splashText.slice(0, 140).replace(/\s+/g, ' '))
  return samples
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.log('找不到 electron 可执行文件：' + ELECTRON)
    process.exit(2)
  }
  if (!existsSync(SERVER_BIN)) {
    console.log('找不到产品服务入口：' + SERVER_BIN)
    process.exit(2)
  }
  let coldSamples = []
  if (MODE === 'attach' || MODE === 'both') await scenarioAttach(Number(process.env.BF_SPLASH_PORT ?? '31299'))
  if (MODE === 'cold' || MODE === 'both') coldSamples = await scenarioCold(Number(process.env.BF_COLD_PORT ?? '31298')) ?? []
  if (MODE === 'packaged') {
    if (!existsSync(PACKAGED_EXE)) {
      console.log('找不到安装版可执行文件：' + PACKAGED_EXE)
      process.exit(2)
    }
    await scenarioPackaged(Number(process.env.BF_PACKAGED_PORT ?? '31296'))
  }

  const failed = checks.filter(c => !c.ok)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const report = [
    '# 启动页进度条验收',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 桌面壳：' + DESKTOP_DIR + '（开发态）',
    '- 档位：' + (PERF === '' ? '未指定（按本机实测）' : PERF) + '；场景：' + MODE,
    '',
    '| 场景 | 断言 | 结果 | 证据 |',
    '| --- | --- | --- | --- |',
    ...checks.map(c => '| ' + c.scenario + ' | ' + c.name + ' | ' + (c.skipped ? 'SKIP' : c.ok ? 'PASS' : 'FAIL') + ' | ' + c.detail.replace(/\|/g, '\\|') + ' |'),
    '',
    '## 场景 B 采样轨迹（每 5 次取 1 次）',
    '',
    '| 时刻(ms) | 阶段 | 百分比 | 模式 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...coldSamples.filter((_s, i) => i % 5 === 0).map(s => '| ' + s.at + ' | ' + s.stage + ' | ' + s.now + '% | ' + s.mode + ' | ' + s.detail.replace(/\|/g, '\\|') + ' |'),
    '',
  ].join('\n')
  const reportFile = join(REPORT_DIR, 'splash-progress-' + stamp + '.md')
  writeFileSync(reportFile, report, 'utf8')
  console.log('报告：' + reportFile)
  const skipped = checks.filter(c => c.skipped).length
  console.log('SPLASH_PROGRESS ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length + ' skipped=' + skipped)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
