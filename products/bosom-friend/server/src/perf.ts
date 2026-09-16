/**
 * 性能档位（服务端侧）。
 *
 * 档位由桌面主进程探测后写进环境变量（BF_PERF_PROFILE / BF_PERF_CAPS）；
 * 纯服务端调试（没有这两个变量）时一律按标准档运行——没测到就不擅自降载，
 * 否则"低配适配"会变成"所有机器都被降载"。
 * @module @deepseek-ai/dsh-bosom-friend-server/perf
 */

/** 档位对应的资源上限；每一项都对应服务端一个真实的资源占用点。 */
export interface PerfCaps {
  /** 内核子进程 Node 堆上限（MB），由桌面壳读取并转成 --max-old-space-size。 */
  maxOldSpaceMb: number
  /** 备份轮转保留份数。 */
  backupKeep: number
  /** 接待引擎默认轮询间隔（分钟）；用户显式配过就按用户的。 */
  receptionIntervalMinutes: number
  /** 内核初始化握手的等待预算（秒），由桌面壳读取。 */
  handshakeTimeoutSeconds: number
  /** 启动等待产品服务就绪的上限（秒），仅供桌面壳参考。 */
  startupWaitSeconds: number
  /** 慢机器提示阈值（毫秒），仅供桌面壳参考。 */
  slowAfterMs: number
  /** 是否保留重特效（粒子/模糊/长动画）。 */
  heavyEffects: boolean
}

/** 档位与它的来源：`env` = 桌面壳探测写入；`default` = 未探测（纯服务端调试）。 */
export interface PerfTier {
  tier: 'low' | 'standard'
  caps: PerfCaps
  source: 'env' | 'default'
}

const STANDARD_CAPS: PerfCaps = {
  maxOldSpaceMb: 4096,
  backupKeep: 30,
  receptionIntervalMinutes: 10,
  handshakeTimeoutSeconds: 120,
  startupWaitSeconds: 90,
  slowAfterMs: 80000,
  heavyEffects: true,
}

/**
 * 读取当前档位。
 *
 * @param env - 进程环境变量；`BF_PERF_PROFILE` 指定档位，`BF_PERF_CAPS` 携带上限。
 * @returns 档位、上限与来源；上限缺失或损坏的字段回退为同档位默认值。
 */
export function perfTier(env: NodeJS.ProcessEnv = process.env): PerfTier {
  const tier: 'low' | 'standard' = env.BF_PERF_PROFILE === 'low' ? 'low' : 'standard'
  const fallback = tier === 'low'
    ? {
        ...STANDARD_CAPS,
        maxOldSpaceMb: 1024,
        backupKeep: 10,
        receptionIntervalMinutes: 20,
        handshakeTimeoutSeconds: 300,
        startupWaitSeconds: 240,
        slowAfterMs: 240000,
        heavyEffects: false,
      }
    : STANDARD_CAPS
  let parsed: Partial<PerfCaps> = {}
  let source: PerfTier['source'] = 'default'
  if (typeof env.BF_PERF_CAPS === 'string' && env.BF_PERF_CAPS !== '') {
    try {
      const raw = JSON.parse(env.BF_PERF_CAPS) as Partial<PerfCaps>
      if (raw !== null && typeof raw === 'object') {
        parsed = raw
        source = 'env'
      }
    }
    catch {
      // 上限串损坏：按同档位的默认上限运行，档位本身仍然生效。
    }
  }
  const caps: PerfCaps = { ...fallback }
  for (const key of Object.keys(fallback) as (keyof PerfCaps)[]) {
    const value = parsed[key]
    if (typeof value === typeof fallback[key]) {
      (caps[key] as unknown) = value
    }
  }
  return { tier, caps, source }
}
