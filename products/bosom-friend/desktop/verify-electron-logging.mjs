#!/usr/bin/env node
/**
 * 出包前预检：日志模块必须在包里，而且必须真的被用上。
 *
 * 为什么需要这条检查：DEF-101 的根因不是"写错了日志"，而是**没有任何东西检查日志有没有进包**。
 * 装出来的 app.asar 里搜不到 logger / appendFile（旧 Electron 工程那套 electron-log 属于另一条
 * 不进包的代码路径），内核 stderr 也没有文件出口——现场出现"网络连接失败 / 生成失败"时，
 * 主进程、渲染进程、内核三侧全都无迹可查，只能靠猜。缺文件不会报错，所以必须由检查来判红。
 *
 * 断言：
 *   1. electron/run-log.cjs 存在，且导出 createRunLog 与 teeConsole；
 *   2. main.cjs 引入它、把日志建在 userData\logs、接管 console、提供日志路径 IPC；
 *   3. main.cjs 把内核输出也纳入留痕（内核退出 / 启动失败各有一条）；
 *   4. preload.cjs 暴露日志出口（bosomLog）；
 *   5. electron-builder 的 files 规则覆盖 electron/**（新文件才会被打进 app.asar）。
 *
 * 用法：node products/bosom-friend/desktop/verify-electron-logging.mjs
 * 退出码：0 = 通过；1 = 有缺口。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const productRoot = join(here, '..')
const electronDir = join(here, 'electron')
const checks = []

/** @param name - 断言名。 @param ok - 是否通过。 @param detail - 失败证据。 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? '' })
}

const runLogPath = join(electronDir, 'run-log.cjs')
const mainPath = join(electronDir, 'main.cjs')
const preloadPath = join(electronDir, 'preload.cjs')

const runLog = existsSync(runLogPath) ? readFileSync(runLogPath, 'utf8') : ''
const main = existsSync(mainPath) ? readFileSync(mainPath, 'utf8') : ''
const preload = existsSync(preloadPath) ? readFileSync(preloadPath, 'utf8') : ''

check('run-log.cjs 存在', runLog !== '', runLogPath)
check('run-log 导出 createRunLog', runLog.includes('function createRunLog') && runLog.includes('createRunLog'), '')
check('run-log 导出 teeConsole', runLog.includes('function teeConsole'), '')
check('run-log 遮蔽密钥', runLog.includes('maskSecrets') && runLog.includes('sk-***'), '')
check('main 引入 run-log', main.includes("require('./run-log.cjs')"), '')
check('main 把日志建在 userData\\logs', main.includes("path.join(app.getPath('userData'), 'logs')"), '')
check('main 接管 console', main.includes('teeConsole(runLog)'), '')
check('main 提供日志路径 IPC', main.includes("ipcMain.handle('bosom-log:path'"), '')
check('main 记录内核退出', main.includes('[kernel] 内核子进程已退出'), '')
check('main 记录内核启动失败', main.includes('[kernel] 启动失败'), '')
check('preload 暴露日志出口', preload.includes('bosomLog') && preload.includes('bosom-log:open'), '')

// electron-builder 的 files 规则：打包时用的那份（source-of-record 在 electron-builder.yml；
// build-win.sh 会据此生成临时 yml，两者都必须覆盖 electron/**）
const builderYml = join(here, 'electron-builder.yml')
const yml = existsSync(builderYml) ? readFileSync(builderYml, 'utf8') : ''
check('electron-builder.yml 覆盖 electron/**', /electron\/\*\*\/\*/.test(yml), builderYml)
const buildWin = join(here, 'build-win.sh')
const buildWinText = existsSync(buildWin) ? readFileSync(buildWin, 'utf8') : ''
check('build-win.sh 覆盖 electron/**', /electron\/\*\*\/\*/.test(buildWinText), buildWin)

// Electron fuse 是安全配置：真正出包读的是 build-win.sh 自己生成的 YAML，静态配置只是留档。
// 两处一旦分叉，就会出现"静态配置改好了、装出来的包却没生效"——出包前必须判红。
// 只断言静态那一份含有 fuse 没有意义，必须比对两处的取值完全一致。
/**
 * 从 YAML 文本里抽出 electronFuses 段，归一化成 "键=值" 的排序数组。
 * @param text - YAML 文件或 heredoc 的全文。
 * @returns 归一化后的 fuse 条目；没有该段时为空数组。
 */
function parseFuses(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => /^electronFuses:\s*$/.test(l))
  if (start === -1) return []
  const entries = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) break
    const m = /^\s+([A-Za-z0-9_]+):\s*(true|false)\s*$/.exec(line)
    if (m) entries.push(m[1] + '=' + m[2])
  }
  return entries.sort()
}

const fusesStatic = parseFuses(yml)
const fusesBuild = parseFuses(buildWinText)
const EXPECTED_FUSES = [
  'enableCookieEncryption=true',
  'enableNodeCliInspectArguments=false',
  'enableNodeOptionsEnvironmentVariable=false',
  'runAsNode=false',
]
check('electron-builder.yml 声明了预期的 fuse 取值', JSON.stringify(fusesStatic) === JSON.stringify(EXPECTED_FUSES), JSON.stringify(fusesStatic))
check('build-win.sh 声明了预期的 fuse 取值', JSON.stringify(fusesBuild) === JSON.stringify(EXPECTED_FUSES), JSON.stringify(fusesBuild))
check('两处 fuse 配置一致（出包读的是 build-win.sh 那一份）', JSON.stringify(fusesStatic) === JSON.stringify(fusesBuild), 'static=' + JSON.stringify(fusesStatic) + ' build=' + JSON.stringify(fusesBuild))

const failed = checks.filter(c => !c.ok)
for (const c of checks)
  console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : '  -> ' + c.detail))
console.log('ELECTRON_LOGGING ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
