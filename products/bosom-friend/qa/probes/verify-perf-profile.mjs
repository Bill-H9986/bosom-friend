#!/usr/bin/env node
/**
 * 性能档位验收：判定边界 + 上限夹取 + 环境透传 + 落盘留痕。
 *
 * 为什么要有它：低配适配一旦判错，代价是双向的——把好机器判成低配＝所有用户被降载；
 * 把低配判成标准＝该降的没降。所以这里用边界值直接钉住判定规则，而不是只看"本机跑起来没崩"。
 *
 * 用法：node products/bosom-friend/qa/probes/verify-perf-profile.mjs
 * 退出码：0 = 全部通过；1 = 存在失败断言。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(dirname(HERE))
const require = createRequire(import.meta.url)
const perf = require(join(PRODUCT, 'desktop', 'electron', 'perf-profile.cjs'))

const checks = []
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''))
}

const { classifyMachine, detectPerfProfile, applyPerfEnv, writePerfProfile } = perf

const low = classifyMachine({ logicalCores: 4, totalMemGb: 8 })
record('4 核 / 8GB 判为低配', low.tier === 'low', low.reasons.join('；'))
record('低配理由说清是 CPU 与内存两条', low.reasons.length === 2, low.reasons.join('；'))

const standard = classifyMachine({ logicalCores: 8, totalMemGb: 16 })
record('8 核 / 16GB 判为标准档', standard.tier === 'standard', standard.reasons.join('；'))
record('标准档保留原有上限（备份 30 份 / 重特效开）',
  standard.caps.backupKeep === 30 && standard.caps.heavyEffects === true && standard.caps.receptionIntervalMinutes === 10,
  JSON.stringify(standard.caps))

const cpuOnly = classifyMachine({ logicalCores: 2, totalMemGb: 32 })
record('只有 CPU 偏弱（2 核 / 32GB）也判低配', cpuOnly.tier === 'low' && cpuOnly.reasons.some(r => r.includes('CPU')), cpuOnly.reasons.join('；'))

const memOnly = classifyMachine({ logicalCores: 16, totalMemGb: 8 })
record('只有内存偏小（16 核 / 8GB）也判低配', memOnly.tier === 'low' && memOnly.reasons.some(r => r.includes('内存')), memOnly.reasons.join('；'))

const forcedLow = classifyMachine({ logicalCores: 32, totalMemGb: 64, override: 'low' })
record('BF_PERF_PROFILE=low 可在好机器上强制低配档', forcedLow.tier === 'low' && forcedLow.reasons.some(r => r.includes('BF_PERF_PROFILE')), forcedLow.reasons.join('；'))
record('强制低配时堆上限按内存 35% 夹到 2048MB 封顶',
  forcedLow.caps.maxOldSpaceMb === 2048, String(forcedLow.caps.maxOldSpaceMb))

const forcedStandard = classifyMachine({ logicalCores: 2, totalMemGb: 4, override: 'standard' })
record('BF_PERF_PROFILE=standard 可在低配机器上强制标准档', forcedStandard.tier === 'standard', forcedStandard.reasons.join('；'))

const tiny = classifyMachine({ logicalCores: 2, totalMemGb: 2 })
record('极小内存（2GB）时堆上限仍不低于 768MB',
  tiny.caps.maxOldSpaceMb >= 768 && tiny.caps.maxOldSpaceMb <= 2048, String(tiny.caps.maxOldSpaceMb))
record('低配档关闭重特效并缩短备份保留', tiny.caps.heavyEffects === false && tiny.caps.backupKeep === 10, JSON.stringify(tiny.caps))

const detected = detectPerfProfile({ BF_PERF_PROFILE: 'low' })
record('detectPerfProfile 读得到实测核数与内存',
  detected.measured.logicalCores > 0 && detected.measured.totalMemGb > 0,
  JSON.stringify(detected.measured))

const env = {}
applyPerfEnv(detected, env)
record('applyPerfEnv 写出档位与可解析的上限串',
  env.BF_PERF_PROFILE === 'low' && JSON.parse(env.BF_PERF_CAPS).backupKeep === 10,
  env.BF_PERF_PROFILE + ' / ' + env.BF_PERF_CAPS)

const dir = mkdtempSync(join(tmpdir(), 'bf-perf-probe-'))
const file = writePerfProfile(dir, detected)
let written = null
try {
  written = JSON.parse(readFileSync(file, 'utf8'))
}
catch {
  // 读不到就是没写成，下面按失败判定
}
record('判定结果落盘留痕（含实测值与理由）',
  written !== null && written.tier === 'low' && Array.isArray(written.reasons) && written.measured !== undefined,
  file)
rmSync(dir, { recursive: true, force: true })

// 启动链路不得同步递归删除：一份内核运行时 417MB / 23 万个文件，同步 rmSync 会把主进程
// 事件循环占满几分钟，窗口显示与 IPC 全部停摆（低配机器上表现为启动页卡死）。
const mainSrc = readFileSync(join(PRODUCT, 'desktop', 'electron', 'main.cjs'), 'utf8')
const syncRecursiveRemoval = [...mainSrc.matchAll(/\w*rmSync\([^)]*recursive:\s*true/g)].map(m => m[0])
record('启动链路没有同步递归删除目录', syncRecursiveRemoval.length === 0,
  syncRecursiveRemoval.length === 0 ? '已改为 fs.promises.rm' : syncRecursiveRemoval.join('；'))

const failed = checks.filter(c => !c.ok)
console.log('PERF_PROFILE ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
