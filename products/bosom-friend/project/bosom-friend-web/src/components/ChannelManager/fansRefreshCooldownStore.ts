/**
 * fansRefreshCooldownStore - 频道粉丝数刷新冷却记录
 * 按平台记录最近一次刷新时间，避免一小时内重复触发。
 */

import type { PlatType } from '@web/app/config/platConfig'
import { createPersistStore } from '@web/utils/storage/createPersistStore'

interface FansRefreshCooldownState {
  platformRecords: Partial<Record<PlatType, number>>
}

const FANS_REFRESH_COOLDOWN = 60 * 60 * 1000

function calcPlatformRefreshRemaining(
  records: Partial<Record<PlatType, number>>,
  platform: PlatType,
) {
  const lastRefreshTime = records[platform] || 0
  return Math.max(0, FANS_REFRESH_COOLDOWN - (Date.now() - lastRefreshTime))
}

export const useFansRefreshCooldownStore = createPersistStore<
  FansRefreshCooldownState,
  {
    /**
     * 记录平台刷新冷却。
     * @param platform - 目标平台。
     * @param remainingMs - 已知的剩余冷却时长；缺省按完整冷却窗口记录。
     */
    markPlatformRefresh: (platform: PlatType, remainingMs?: number) => void
    canPlatformRefresh: (platform: PlatType) => boolean
    getPlatformRefreshRemaining: (platform: PlatType) => number
  }
>(
  { platformRecords: {} },
  (set, get) => ({
    markPlatformRefresh(platform, remainingMs) {
      const state = get()
      const bounded = typeof remainingMs === 'number' && remainingMs > 0
        ? Math.min(remainingMs, FANS_REFRESH_COOLDOWN)
        : FANS_REFRESH_COOLDOWN
      set({
        platformRecords: {
          ...state.platformRecords,
          [platform]: Date.now() - (FANS_REFRESH_COOLDOWN - bounded),
        },
      })
    },

    canPlatformRefresh(platform) {
      return calcPlatformRefreshRemaining(get().platformRecords, platform) <= 0
    },

    getPlatformRefreshRemaining(platform) {
      return calcPlatformRefreshRemaining(get().platformRecords, platform)
    },
  }),
  { name: 'zhiyin-channel-fans-refresh-cooldown', version: 1 },
)
