#!/usr/bin/env node
/**
 * 安装版 AI 业务验收：让**装好的应用**（不是开发版）用真实大模型跑完一条完整业务。
 *
 * 为什么单独做这一条：门禁里的 AI 用例跑的是开发实例（源码 + 开发数据根），
 * 装机版走的是随包内核运行时、随包前端、真实数据根与真实凭据——两者不是同一份东西。
 * 「安装版业务链路待验」是 AC-020-1 一直挂着的半条，这里把它补上。
 *
 * 代价提示：会真实调用大模型（约 5~8 次），消耗账号额度。
 *
 * 用法：node products/bosom-friend/qa/probes/verify-installed-ai-business.mjs
 * 退出码：0 = 用例全绿；1 = 有用例失败；2 = 环境不满足（未安装 / 起不来）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const QA = dirname(HERE)
const PRODUCT = dirname(QA)
const E2E_DIR = join(QA, 'e2e')
const EXE = process.env.BF_GATE30_EXE
  ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'Bosom Friend.exe')
const PORT = process.env.BF_INSTALLED_PORT ?? '31296'
const BASE = 'http://127.0.0.1:' + PORT + '/bosom-friend/'
const CASES = process.env.BF_INSTALLED_CASES ?? 'AC-004-1|AC-016-1|AC-018-1'
const REPORT_DIR = join(QA, 'reports')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function isUp() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const response = await fetch(BASE, { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  }
  catch {
    return false
  }
}

function killTree(child) {
  if (child === null || child.exitCode !== null) return
  spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

async function main() {
  if (!existsSync(EXE)) {
    console.log('找不到安装版可执行文件：' + EXE)
    process.exit(2)
  }
  mkdirSync(REPORT_DIR, { recursive: true })
  if (await isUp()) {
    console.log('端口 ' + PORT + ' 上已有产品在服务，先关掉再测（避免测到别的实例）。')
    process.exit(2)
  }

  // 用真实数据根与真实凭据（模型的 Base URL / Key 就在那里）；端口让开默认值，逼它自己起内核。
  const app = spawn(EXE, [], {
    env: { ...process.env, BF_DESKTOP_PORT: PORT },
    stdio: 'ignore',
    windowsHide: false,
    detached: false,
  })
  let e2e = null
  try {
    const deadline = Date.now() + 240_000
    let up = false
    while (Date.now() < deadline) {
      if (await isUp()) { up = true; break }
      if (app.exitCode !== null) break
      await sleep(2000)
    }
    if (!up) {
      console.log('安装版在 240 秒内没有把产品服务起起来（exit=' + app.exitCode + '）')
      process.exit(2)
    }
    console.log('安装版已就绪：' + BASE)
    console.log('跑真实模型用例：' + CASES)

    e2e = await new Promise((resolve) => {
      // shell:true 下 -g 的模式会被 cmd 当成管道符，必须自带引号（Windows 上 npx.cmd 又必须要 shell）。
      const child = spawn('npx', ['playwright', 'test', '-g', '"' + CASES + '"', '--reporter=list'], {
        cwd: E2E_DIR,
        env: { ...process.env, BF_QA_BASE: BASE },
        shell: true,
      })
      let out = ''
      child.stdout.on('data', chunk => { out += String(chunk) })
      child.stderr.on('data', chunk => { out += String(chunk) })
      child.on('exit', code => resolve({ code, out }))
    })
    const tail = e2e.out.split(/\r?\n/).filter(Boolean).slice(-25).join('\n')
    console.log(tail)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const summary = e2e.out.split(/\r?\n/).find(l => /\d+ (passed|failed)/.test(l)) ?? ''
    writeFileSync(join(REPORT_DIR, 'installed-ai-business-' + stamp + '.md'), [
      '# 安装版 AI 业务验收（真实大模型）',
      '',
      '- 时间：' + new Date().toISOString(),
      '- 被测对象：' + EXE + '（端口 ' + PORT + '，真实数据根与真实凭据）',
      '- 用例：' + CASES,
      '- 结果：' + (summary || '（无摘要行）'),
      '',
      '```',
      e2e.out.split(/\r?\n/).filter(Boolean).slice(-40).join('\n'),
      '```',
      '',
    ].join('\n'), 'utf8')
  }
  finally {
    // 托盘常驻应用必须连同内核子进程一起收干净，否则下一次测端口还是被占着。
    killTree(app)
    await sleep(3000)
  }
  process.exit(e2e !== null && e2e.code === 0 ? 0 : 1)
}

await main()
