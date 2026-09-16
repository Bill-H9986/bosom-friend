/**
 * 性能档位探测：低配机型适配的唯一判定来源。
 *
 * 判定只看能如实测到的硬件事实（逻辑核心数、物理内存）与显式覆盖（BF_PERF_PROFILE），
 * 不猜磁盘类型、不猜显卡型号：猜错的代价要么是正常机器被无谓降载，要么是低配机器没被降载。
 * 判定结果与理由同时落盘 <userData>/perf-profile.json，现场排查能直接看到"为什么被判成低配"。
 *
 * 输出给下游三处使用：
 *  - 桌面主进程：启动等待上限、慢机器提示阈值、GPU 兜底策略；
 *  - 内核子进程：Node 堆上限（防止低内存机器一路吃到换页）；
 *  - 服务端：备份保留份数、接待引擎每轮上限、前端是否关闭重特效。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 低配判定阈值：逻辑核心数 ≤ 4 或物理内存 ≤ 8GB。 */
const LOW_TIER_MAX_LOGICAL_CORES = 4
const LOW_TIER_MAX_MEMORY_GB = 8

/** 档位对应的资源上限；每一项都对应代码里一个真实的资源占用点。 */
function capsForTier(tier, totalMemGb) {
  if (tier === 'low') {
    return {
      // 内核子进程堆上限：按物理内存的 35% 夹在 768MB~2048MB，低内存机器不再无上限增长。
      maxOldSpaceMb: Math.max(768, Math.min(2048, Math.floor(totalMemGb * 1024 * 0.35))),
      backupKeep: 10,
      // 后台轮询间隔拉长：接待引擎每轮都要拉起平台引擎读列表，低配机器上这是最贵的后台动作。
      receptionIntervalMinutes: 20,
      // 内核握手预算：低配机器（机械盘 + 冷启动解压）实测能到几分钟，给足时间再判失败。
      handshakeTimeoutSeconds: 300,
      startupWaitSeconds: 240,
      slowAfterMs: 240000,
      heavyEffects: false,
    }
  }
  return {
    maxOldSpaceMb: 4096,
    backupKeep: 30,
    receptionIntervalMinutes: 10,
    handshakeTimeoutSeconds: 120,
    startupWaitSeconds: 90,
    slowAfterMs: 80000,
    heavyEffects: true,
  }
}

/**
 * 按硬件事实判定档位（纯函数，便于用边界值直接验收）。
 *
 * @param input - `logicalCores` / `totalMemGb` 为实测值，`override` 为 BF_PERF_PROFILE 的显式指定。
 * @returns 档位、判定理由（面向用户可读）与对应资源上限。
 */
function classifyMachine(input) {
  const logicalCores = Number(input?.logicalCores) || 0
  const totalMemGb = Number(input?.totalMemGb) || 0
  const override = input?.override === 'low' || input?.override === 'standard' ? input.override : ''
  const reasons = []
  let tier = 'standard'
  if (override === 'low') {
    tier = 'low'
    reasons.push('BF_PERF_PROFILE=low 指定')
  }
  else if (override === 'standard') {
    reasons.push('BF_PERF_PROFILE=standard 指定')
  }
  else {
    if (logicalCores > 0 && logicalCores <= LOW_TIER_MAX_LOGICAL_CORES) {
      tier = 'low'
      reasons.push('CPU 逻辑核心仅 ' + logicalCores + ' 个')
    }
    if (totalMemGb > 0 && totalMemGb <= LOW_TIER_MAX_MEMORY_GB) {
      tier = 'low'
      reasons.push('物理内存仅 ' + totalMemGb.toFixed(1) + ' GB')
    }
    if (reasons.length === 0) {
      reasons.push('CPU ' + logicalCores + ' 核 / 内存 ' + totalMemGb.toFixed(1) + ' GB')
    }
  }
  return { tier, reasons, caps: capsForTier(tier, totalMemGb > 0 ? totalMemGb : 8) }
}

/**
 * 探测本机档位。
 *
 * @param env - 进程环境变量（读取 BF_PERF_PROFILE 覆盖）。
 * @returns 与 {@link classifyMachine} 相同，另附实测输入。
 */
function detectPerfProfile(env = process.env) {
  const logicalCores = os.cpus().length
  const totalMemGb = os.totalmem() / (1024 ** 3)
  const detected = classifyMachine({ logicalCores, totalMemGb, override: env.BF_PERF_PROFILE })
  return {
    ...detected,
    detectedAt: new Date().toISOString(),
    measured: { logicalCores, totalMemGb: Number(totalMemGb.toFixed(1)) },
  }
}

/**
 * 把档位写进环境变量，供内核子进程与服务端读取。
 *
 * @param profile - {@link detectPerfProfile} 的结果。
 * @param env - 目标环境变量对象（默认 process.env）。
 */
function applyPerfEnv(profile, env = process.env) {
  env.BF_PERF_PROFILE = profile.tier
  env.BF_PERF_CAPS = JSON.stringify(profile.caps)
}

/**
 * 落盘判定留痕；写失败不阻塞启动（只影响排查便利）。
 *
 * @param userData - Electron 用户数据目录。
 * @param profile - {@link detectPerfProfile} 的结果。
 * @returns 写入的文件路径；失败时为调用方传入目录下的同名路径。
 */
function writePerfProfile(userData, profile) {
  const file = path.join(userData, 'perf-profile.json')
  try {
    fs.writeFileSync(file, JSON.stringify(profile, null, 2), 'utf8')
  }
  catch {
    // 目录只读或不存在时跳过：档位本身已经在内存与环境变量里生效。
  }
  return file
}

module.exports = {
  LOW_TIER_MAX_LOGICAL_CORES,
  LOW_TIER_MAX_MEMORY_GB,
  capsForTier,
  classifyMachine,
  detectPerfProfile,
  applyPerfEnv,
  writePerfProfile,
}
