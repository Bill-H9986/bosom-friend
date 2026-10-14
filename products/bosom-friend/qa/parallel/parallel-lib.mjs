#!/usr/bin/env node
/**
 * 并行桌面测试公共库。
 *
 * 规则：
 *  - 每个 worker 使用独立 Electron userData + 独立 BF_DESKTOP_PORT + 独立 BOSOM_FRIEND_HOME；
 *  - 只通过真实页面操作和观察；任何后端调用不作为产品通过依据；
 *  - 基础设施准备（复制运行时装、截图、写报告）不算产品验收动作。
 */
import { createRequire } from 'node:module'
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
export const productRoot = join(repoRoot, 'products', 'bosom-friend')
export const evidenceDir = join(productRoot, 'qa', 'evidence', 'parallel-2026-09-04')
export const runtimeSrc = join(productRoot, 'desktop', 'dist', 'kernel-runtime-unpacked')
export const frontendDist = join(productRoot, 'project', 'bosom-friend-electron', 'dist')
export const electronExe = join(productRoot, 'project', 'bosom-friend-electron', 'node_modules', 'electron', 'dist', 'electron.exe')
export const desktopDir = join(productRoot, 'desktop')

export const exePath = process.env.BF_DESKTOP_EXE
  || join(productRoot, 'desktop', 'release', '0.2.31', 'win-unpacked', 'Bosom Friend.exe')

export const { _electron: electron } = require(join(
  repoRoot,
  'node_modules',
  '.pnpm',
  'playwright@1.61.1',
  'node_modules',
  'playwright',
  'test',
))

mkdirSync(evidenceDir, { recursive: true })

/** 准备 worker 的独立目录：产品数据根、用户目录、可选运行时装。 */
export function prepareWorker(spec, options = {}) {
  const runId = process.env.BF_PARALLEL_RUN_ID || String(Date.now())
  const workerDir = join(evidenceDir, `worker-${String(spec.index).padStart(2, '0')}-${runId}`)
  const userData = join(workerDir, 'user-data')
  const home = join(workerDir, 'home')
  const shotDir = join(workerDir, 'shots')
  mkdirSync(userData, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(shotDir, { recursive: true })

  // 独立运行时装：避免每个实例重复从安装包解压 1GB，也避免真实用户目录被测试污染。
  if (options.installRuntime !== false && existsSync(runtimeSrc)) {
    const dest = join(userData, 'kernel-runtime')
    if (!existsSync(join(dest, 'runtime', 'bin-desktop.mjs'))) {
      try {
        // 运行时装只读复用。产品数据仍由 BOSOM_FRIEND_HOME 完全隔离。
        symlinkSync(runtimeSrc, dest, 'junction')
      } catch {
        cpSync(runtimeSrc, dest, { recursive: true, force: true })
      }
    }
  }

  // 仅在需要真实 AI 的 worker 中复制本机已保存的模型配置；绝不在日志里打印内容。
  if (options.seedLlm) {
    const srcLlm = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend', 'llm-user.json')
    const destLlm = join(home, 'bosom-friend', 'llm-user.json')
    if (existsSync(srcLlm)) {
      mkdirSync(join(home, 'bosom-friend'), { recursive: true })
      copyFileSync(srcLlm, destLlm)
    }
  }

  return { workerDir, userData, home, shotDir }
}

/** 启动一个真实 Electron 实例；开发态与安装态都走同一入口参数。 */
export async function launchWorker(spec, worker) {
  const args = [
    ...(process.env.BF_DESKTOP_DEV === '1' ? [desktopDir] : []),
    `--user-data-dir=${worker.userData}`,
  ]
  const env = {
    ...process.env,
    BF_DESKTOP_PORT: String(spec.port),
    BOSOM_FRIEND_HOME: worker.home,
    BF_FRONTEND_DIST: frontendDist,
  }
  const app = await electron.launch({
    executablePath: process.env.BF_DESKTOP_DEV === '1' ? electronExe : exePath,
    args,
    env,
  })
  return app
}

/** 关闭真实实例并等待进程退出。 */
export async function closeWorker(app) {
  if (!app) return
  try {
    const win = app.windows()[0]
    if (win) await win.evaluate(() => window.bosomFriend?.quit?.()).catch(() => {})
    await new Promise((resolveWait) => setTimeout(resolveWait, 900))
  } catch {
    // best effort
  }
  try {
    await app.close().catch(() => {})
  } catch {
    // best effort
  }
}

/** 截图并返回证据路径；截屏失败不阻断测试，但会记录。 */
export async function shot(page, workerDir, name) {
  const file = join(workerDir, 'shots', `${name}.png`)
  try {
    await page.screenshot({ path: file, fullPage: false })
  } catch {
    // screenshot failure is diagnostic only
  }
  return file
}

export function bodyText(page) {
  return page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ')).catch(() => '')
}

/** 接收免责声明弹窗（产品真实首次进入流程）。 */
export async function acceptDisclaimer(page) {
  await page.waitForTimeout(1200)
  let agreed = false
  for (let i = 0; i < 12; i += 1) {
    const dialog = page.locator('[role="dialog"]').filter({ hasText: '免责声明' }).first()
    if (await dialog.count() > 0 && await dialog.isVisible().catch(() => false)) {
      const agree = dialog.locator("button:has-text('我已阅读并同意')").first()
      if (!agreed && await agree.count() > 0 && await agree.isVisible().catch(() => false)) {
        await agree.click({ timeout: 3000 }).catch(() => {})
        agreed = true
        await page.waitForTimeout(350)
      }
      const enter = dialog.locator("button:has-text('同意并进入平台')").first()
      if (await enter.count() > 0 && await enter.isVisible().catch(() => false) && await enter.isEnabled().catch(() => false)) {
        await enter.click({ timeout: 3000 }).catch(() => {})
        await page.waitForTimeout(500)
      }
    } else {
      break
    }
    await page.waitForTimeout(350)
  }
}

export function makeReporter(moduleName) {
  const checks = []
  const failures = []
  const pageErrors = []
  return {
    checks,
    failures,
    pageErrors,
    startedAt: new Date().toISOString(),
    module: moduleName,
    add(id, result, detail = '', shotPath = '') {
      checks.push({ id, result, detail, shotPath, at: new Date().toISOString() })
      return result
    },
    fail(id, detail = '', shotPath = '') {
      failures.push({ id, detail, shotPath, at: new Date().toISOString() })
      this.add(id, 'FAIL', detail, shotPath)
    },
    pass(id, detail = '', shotPath = '') {
      this.add(id, 'PASS', detail, shotPath)
    },
    na(id, detail = '', shotPath = '') {
      this.add(id, 'N/A', detail, shotPath)
    },
    async write(workerDir, pass) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      const report = {
        module: this.module,
        startedAt: this.startedAt,
        endedAt: new Date().toISOString(),
        pass: Boolean(pass) && this.failures.length === 0,
        checks: this.checks,
        failures: this.failures,
        pageErrors: this.pageErrors,
        evidenceDir: workerDir,
      }
      writeFileSync(join(workerDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
      return report
    },
  }
}
