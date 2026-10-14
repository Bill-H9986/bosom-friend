#!/usr/bin/env node
/**
 * 前端类型门禁：**web 应用硬零，electron 主进程棘轮**。
 *
 * 背景：前端一直没有任何类型检查在跑（`vite build` 走 esbuild 不做类型检查，CI 只覆盖 server 与 kernel）。
 * 后果是实测到的一族缺陷：请求层返回的是信封 `{code, data, message}`，调用方却读 `res.field` / `res.list`，
 * **成功也走失败分支**——而构建、单测、门禁全绿（DEF-139 是这一族，DEF-140 记了它的根因）。
 * 同一轮里还查出 `get().reset()` 调的是一个**根本不存在的方法**（走到那条分支就是运行时 TypeError）。
 *
 * 两个上限为什么不一样：
 * - **web 应用（`bosom-friend-web/src`）上限是 0**：它已经清干净了，所以从今往后**任何**新增都是回归。
 * - **electron 主进程上限 45**：剩下的多数是引用了本移植里不存在的 `bosom-friend-harness`，
 *   以及一批隐式 any。它们与产品界面无关，一次性清完风险与收益不成比例；用棘轮挡着不再恶化，
 *   每清一批就把 `ELECTRON_CEILING` 改小。
 *
 * 用法：node products/bosom-friend/qa/verify-frontend-types.mjs
 * 退出码：0 = 两侧都没超上限；1 = 有一侧超了。
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const REPO = resolve(PRODUCT, '..', '..')
const CONFIG = join(PRODUCT, 'project', 'bosom-friend-electron', 'tsconfig.json')

/** web 应用上限：**必须保持 0**（2026-09-22 由 13 清到 0）。 */
const WEB_CEILING = 0
/** electron 主进程上限：棘轮，只许改小（2026-09-22 实测 45）。 */
const ELECTRON_CEILING = 45

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', CONFIG, '--pretty', 'false'], {
  cwd: REPO,
  encoding: 'utf8',
  timeout: 15 * 60 * 1000,
})
const errors = `${run.stdout || ''}${run.stderr || ''}`
  .split(/\r?\n/)
  .filter(line => line.includes('error TS'))

/** 这条错误属于哪一侧：路径第一段是 `electron/` 就是主进程，其余都算 web 应用。 */
function sideOf(line) {
  const file = line.split('(')[0].replace(/^products\/bosom-friend\/project\/bosom-friend-electron\//, '')
  return file.startsWith('electron/') ? 'electron' : 'web'
}

const web = errors.filter(line => sideOf(line) === 'web')
const electron = errors.filter(line => sideOf(line) === 'electron')

const problems = []
if (web.length > WEB_CEILING) {
  problems.push('web 应用 ' + web.length + ' 条（上限 ' + WEB_CEILING + '）——它必须保持 0')
}
if (electron.length > ELECTRON_CEILING) {
  problems.push('electron 主进程 ' + electron.length + ' 条（上限 ' + ELECTRON_CEILING + '）')
}

if (problems.length > 0) {
  console.log('FRONTEND_TYPES_FAIL ' + problems.join('；'))
  for (const line of web.slice(0, 5)) console.log('  ' + line)
  console.log('  完整列表：npx tsc --noEmit -p products/bosom-friend/project/bosom-friend-electron/tsconfig.json')
  process.exit(1)
}

console.log('FRONTEND_TYPES_OK web=' + web.length + '/' + WEB_CEILING + ' electron=' + electron.length + '/' + ELECTRON_CEILING)
if (electron.length < ELECTRON_CEILING) {
  console.log('  electron 侧比上限少了 ' + (ELECTRON_CEILING - electron.length) + ' 条：把 ELECTRON_CEILING 改到 ' + electron.length + '，水位才算记下来。')
}
process.exit(0)
