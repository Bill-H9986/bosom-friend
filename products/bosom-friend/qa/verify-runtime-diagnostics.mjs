#!/usr/bin/env node
/**
 * 运行可诊断性验收：日志、内核自愈、前端诚实提示三者必须同时在线。
 *
 * 为什么需要这份检查：现场出现「一直弹网络连接失败 + 卡片生成失败」时，产品既不写运行日志、
 * 内核死后也没有任何检测与恢复入口、前端还把三种不同原因混成同一句话（DEF-083）。三者缺一，
 * 同一个故障就会再次变成"只能靠猜"。因此这里把链路逐环钉死：少一环即红灯。
 *
 * 用法：node products/bosom-friend/qa/verify-runtime-diagnostics.mjs
 * 退出码：0 = 全部通过；1 = 有缺口。
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const qaDir = dirname(fileURLToPath(import.meta.url))
const productRoot = join(qaDir, '..')
const checks = []

/** @param name - 断言名。 @param ok - 是否通过。 @param detail - 失败证据。 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? '' })
}

/** @param rel - 相对产品根的路径。 @returns 文件内容；缺失返回空串。 */
function read(rel) {
  const file = join(productRoot, rel)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

const main = read(join('desktop', 'electron', 'main.cjs'))
const kernelHost = read(join('desktop', 'electron', 'kernel-host.cjs'))
const preload = read(join('desktop', 'electron', 'preload.cjs'))
const runLog = read(join('desktop', 'electron', 'run-log.cjs'))
const layout = read(join('project', 'bosom-friend-web', 'src', 'desktop-pages', 'WebAppLayout.tsx'))
const banner = read(join('project', 'bosom-friend-web', 'src', 'components', 'KernelHealthBanner', 'index.tsx'))
const client = read(join('project', 'bosom-friend-web', 'src', 'utils', 'request', 'client.ts'))

// 1) 运行日志模块本身
check('run-log 模块导出 createRunLog/teeConsole', runLog.includes('createRunLog') && runLog.includes('teeConsole'), '')
check('run-log 遮蔽密钥形态字符串', runLog.includes('maskSecrets') && runLog.includes('sk-***'), '')

// 2) 主进程接线：建档、抄 console、写启动事实
check('main 装载运行日志', main.includes("require('./run-log.cjs')") && main.includes('createRunLog('), '')
check('main 日志落在 userData\\logs', main.includes("path.join(app.getPath('userData'), 'logs')"), '')
check('main 接管 console', main.includes('teeConsole(runLog)'), '')
check('main 记录启动事实', main.includes("'[boot] 版本='") && main.includes("'[boot] 产品地址='"), '')

// 3) 内核生命周期留痕：启动、握手、退出、失败
check('main 记录内核启动', main.includes("'[kernel] 启动内核进程"), '')
check('main 记录握手结果', main.includes("'[kernel] 初始化握手完成"), '')
check('main 记录内核退出', main.includes("'[kernel] 内核子进程已退出"), '')
check('main 记录启动失败', main.includes("'[kernel] 启动失败"), '')
check('kernel-host 上报非主动退出', kernelHost.includes('options.onExit') && kernelHost.includes('!closed'), '')

// 4) 内核自愈：探活、判定、自动重启、冷却
check('main 有健康探活', main.includes('checkKernelHealth') && main.includes('HEALTH_PROBE_INTERVAL_MS'), '')
check('main 连续失败才判掉线', main.includes('HEALTH_FAILS_TO_DECLARE_DOWN'), '')
check('main 自动重启有冷却', main.includes('HEALTH_RESTART_COOLDOWN_MS') && main.includes('restartKernel('), '')
check('main 启动即开始监测', main.includes('startKernelSupervision()'), '')
// 启动期间不得判掉线：低配冷启动 2-3 分钟，而探活 30 秒就会判掉线并重启——那会打断正在进行的握手。
check('启动期间屏蔽健康判定', main.includes('if (kernelStarting) {') && main.includes('kernelStarting = false'), '')
check('同一时刻只允许一次启动', main.includes('已有一次内核启动在进行中'), '')

// 5) 恢复出口：IPC + preload + 界面横幅
check('main 提供重启内核 IPC', main.includes("ipcMain.handle('bosom-kernel:restart'"), '')
check('main 提供日志路径/打开目录 IPC', main.includes("ipcMain.handle('bosom-log:path'") && main.includes("ipcMain.handle('bosom-log:open'"), '')
check('preload 暴露重启与健康订阅', preload.includes('restart:') && preload.includes('onHealth:'), '')
check('preload 暴露日志出口', preload.includes('bosomLog') && preload.includes('openFolder'), '')
check('桌面壳挂载内核横幅', layout.includes('KernelHealthBanner'), '')
check('横幅能重启内核并打开日志', banner.includes('restart()') && banner.includes('openFolder'), '')

// 6) 前端诚实提示与留痕
check('client 分类失败原因', client.includes('classifyRequestFailure'), '')
check('client 失败写控制台', client.includes("console.error('[req] 请求失败"), '')
check('client 用分类结果出文案', client.includes('failure.messageKey'), '')
check('main 抄渲染进程 console', main.includes("'console-message'") && main.includes('[renderer:'), '')

// 7) 六种语言都要有新文案
const locales = ['zh-CN', 'en', 'de', 'fr', 'ja', 'ko']
for (const lang of locales) {
  const text = read(join('project', 'bosom-friend-web', 'src', 'app', 'i18n', 'locales', lang, 'common.json'))
  const ok = text.includes('"backendUnreachable"') && text.includes('"backendTimeout"') && text.includes('"backendBadResponse"')
  check('文案齐备 ' + lang, ok, '')
}

// 8) 落盘行为由专项脚本真跑一遍（真实文件系统，不打桩）
const runLogGate = join(qaDir, 'verify-run-log.mjs')
if (!existsSync(runLogGate)) {
  check('落盘行为验收脚本存在', false, runLogGate)
}
else {
  const res = spawnSync(process.execPath, [runLogGate], { encoding: 'utf8', timeout: 60 * 1000 })
  const out = (res.stdout || '') + (res.stderr || '')
  const summary = out.split(/\r?\n/).find(l => l.startsWith('RUN_LOG ')) ?? ''
  check('落盘行为验收通过', res.status === 0 && summary.includes('PASS'), summary || out.slice(-200))
}

const failed = checks.filter(c => !c.ok)
for (const c of checks)
  console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : '  -> ' + c.detail))
console.log('RUNTIME_DIAG ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
