/**
 * useFansRefresh - 频道粉丝数刷新逻辑
 * 统一处理平台冷却、插件平台同步和账号 analytics 刷新。
 */

'use client'

import type { SocialAccount } from '@web/api/accounts/account.types'
import type { PlatType } from '@web/app/config/platConfig'
import type { PluginPlatformType } from '@web/store/plugin'
import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { refreshAccountFansApi } from '@web/api/accounts/account.api'
import { AccountStatus } from '@web/app/config/accountConfig'
import { useTransClient } from '@web/app/i18n/client'
import { useAccountStore } from '@web/store/account'
import { usePlatformMetadataStore } from '@web/store/platformMetadata'
import {
  isPluginPlatformAccountReady,
  PluginStatus,
  usePluginStore,
} from '@web/store/plugin'
import { notification } from '@web/utils/ui/notification'
import { useFansRefreshCooldownStore } from '../fansRefreshCooldownStore'
import { isPlatformFansRefreshSupported, isPluginFansRefreshPlatform } from '../utils/fansRefreshSupport'

type FansRefreshTarget = 'all' | PlatType | null

type PlatformRefreshKind = 'sync' | 'async'

type PlatformRefreshStatus = 'success' | 'partial' | 'failed' | 'skipped'
type PlatformRefreshSkippedReason = 'cooldown' | 'empty' | 'unsupported'

interface FansRefreshProgress {
  current: number
  total: number
}

interface PlatformRefreshResult {
  platform: PlatType
  status: PlatformRefreshStatus
  kind?: PlatformRefreshKind
  skippedReason?: PlatformRefreshSkippedReason
  remainingMs?: number
  message?: string
}

function getUniquePlatforms(accounts: SocialAccount[]) {
  const platforms: PlatType[] = []
  const seen = new Set<PlatType>()

  for (const account of accounts) {
    if (!seen.has(account.type)) {
      seen.add(account.type)
      platforms.push(account.type)
    }
  }

  return platforms
}

function isSuccessfulResult(result: PlatformRefreshResult) {
  return result.status === 'success' || result.status === 'partial'
}

export function useFansRefresh() {
  const { t } = useTransClient('account')
  const [refreshingTarget, setRefreshingTarget] = useState<FansRefreshTarget>(null)
  const [refreshProgress, setRefreshProgress] = useState<FansRefreshProgress | null>(null)
  const platformInfoMap = usePlatformMetadataStore(state => state.map)

  const { accountList } = useAccountStore(
    useShallow(state => ({
      accountList: state.accountList,
    })),
  )

  const {
    pluginStatus,
    refreshAllPlatformAccounts,
    syncAccountToDatabase,
    openPluginModal,
  } = usePluginStore(
    useShallow(state => ({
      pluginStatus: state.status,
      refreshAllPlatformAccounts: state.refreshAllPlatformAccounts,
      syncAccountToDatabase: state.syncAccountToDatabase,
      openPluginModal: state.openPluginModal,
    })),
  )

  const { markPlatformRefresh, getPlatformRefreshRemaining } = useFansRefreshCooldownStore(
    useShallow(state => ({
      markPlatformRefresh: state.markPlatformRefresh,
      getPlatformRefreshRemaining: state.getPlatformRefreshRemaining,
    })),
  )

  // 平台已判定登录失效的账号不参与刷新：拉取必然失败，按钮旁的说明也承诺"登录过期账号会自动跳过"。
  // 之前只按 status 过滤，失效账号照样触发平台拉取，最后还弹"粉丝数刷新完成"，用户以为数据更新了。
  const usableAccounts = useMemo(
    () => accountList.filter(account => account.status === AccountStatus.USABLE && account.loginState !== 'invalid'),
    [accountList],
  )

  const refreshablePlatforms = useMemo(
    () => getUniquePlatforms(usableAccounts)
      .filter(platform => isPlatformFansRefreshSupported(platform, platformInfoMap.get(platform))),
    [platformInfoMap, usableAccounts],
  )

  const getPlatformName = useCallback((platform: PlatType) => {
    return platformInfoMap.get(platform)?.name || platform
  }, [platformInfoMap])

  const formatPlatformNames = useCallback(
    (platforms: PlatType[]) => {
      const names = platforms.map(platform => getPlatformName(platform))
      const separator = t('channelManager.platformNameSeparator')
      const lastSeparator = t('channelManager.platformNameLastSeparator')

      if (names.length <= 1)
        return names[0] || ''

      if (names.length === 2)
        return `${names[0]}${lastSeparator}${names[1]}`

      return `${names.slice(0, -1).join(separator)}${lastSeparator}${names[names.length - 1]}`
    },
    [getPlatformName, t],
  )

  const getPlatformAccounts = useCallback(
    (platform: PlatType) => usableAccounts.filter(account => account.type === platform),
    [usableAccounts],
  )

  const refreshPluginPlatform = useCallback(
    async (platform: PluginPlatformType, accounts: SocialAccount[]): Promise<PlatformRefreshResult> => {
      const platformName = getPlatformName(platform)

      if (pluginStatus !== PluginStatus.READY) {
        openPluginModal()
        return {
          platform,
          status: 'failed',
          kind: 'sync',
          message: t('channelManager.pluginNotReady', { platform: platformName }),
        }
      }

      try {
        await refreshAllPlatformAccounts()

        const pluginAccount = usePluginStore.getState().platformAccounts[platform]
        if (!isPluginPlatformAccountReady(pluginAccount)) {
          openPluginModal()
          return {
            platform,
            status: 'failed',
            kind: 'sync',
            message: t('channelManager.platformNotLoggedIn', { platform: platformName }),
          }
        }

        const matchedAccount = accounts.find(account => account.uid === pluginAccount.uid)
        if (!matchedAccount) {
          return {
            platform,
            status: 'failed',
            kind: 'sync',
            message: t('channelManager.refreshFansNoMatchedPluginAccount', { platform: platformName }),
          }
        }

        const result = await syncAccountToDatabase(platform, matchedAccount.groupId)
        if (!result) {
          return {
            platform,
            status: 'failed',
            kind: 'sync',
            message: t('channelManager.syncFailed'),
          }
        }

        return { platform, status: 'success', kind: 'sync' }
      }
      catch (error) {
        console.error('Refresh plugin fans failed:', error)
        return {
          platform,
          status: 'failed',
          kind: 'sync',
          message: t('channelManager.refreshFansFailed'),
        }
      }
    },
    [
      getPlatformName,
      openPluginModal,
      pluginStatus,
      refreshAllPlatformAccounts,
      syncAccountToDatabase,
      t,
    ],
  )

  const refreshAnalyticsPlatform = useCallback(
    async (platform: PlatType, accounts: SocialAccount[]): Promise<PlatformRefreshResult> => {
      try {
        const responses = await Promise.all(
          accounts.map(account => refreshAccountFansApi(account.id)),
        )
        // 接口 code===0 只说明"请求被受理"，不代表数字已经刷新：
        // 真实平台采集要 20 秒以上，服务端用 refreshStatus 如实区分
        // completed（本次已采集完）/ started（已开始采集）/ in_flight / throttled。
        const completed = responses.filter(response => response?.code === 0 && response.data.refreshStatus === 'completed')
        const pending = responses.filter(response => response?.code === 0
          && (response.data.refreshStatus === 'started' || response.data.refreshStatus === 'in_flight'))
        // 未重复采集（仍在刷新间隔内）既不是成功也不是失败：按 warning 如实说原因，绝不报"刷新完成"。
        const notRefreshed = responses.filter(response => response?.code === 0 && response.data.refreshStatus === 'throttled')
        const failed = responses.filter(response => response?.code !== 0)

        if (failed.length > 0) {
          const failedResponse = failed.find(response => response?.message)
          if (completed.length === 0 && pending.length === 0) {
            return {
              platform,
              status: 'failed',
              kind: 'sync',
              message: failedResponse?.message || t('channelManager.refreshFansFailed'),
            }
          }
          return { platform, status: 'partial', kind: 'sync' }
        }

        if (completed.length === accounts.length)
          return { platform, status: 'success', kind: 'sync' }

        // 有账号已采完、有账号还在采集（或未重复采集）时，只说"已提交/采集中"，
        // 不把没刷新的账号一起算进"刷新完成"。
        if (pending.length > 0 || completed.length > 0)
          return { platform, status: 'success', kind: 'async', message: pending[0]?.data.message }

        // 只剩 throttled：仍在刷新间隔内，既不是成功也不是失败。
        // 归类为 cooldown 而不是 failed——报 failed 会让界面说「刷新失败」，
        // 且不会记录本地冷却，下一次点击会再次打到接口（A10 回归判据）。
        return {
          platform,
          status: 'skipped',
          kind: 'sync',
          skippedReason: 'cooldown',
          ...(typeof notRefreshed[0]?.data.remainingMs === 'number' ? { remainingMs: notRefreshed[0].data.remainingMs } : {}),
          message: notRefreshed[0]?.data.message || t('channelManager.refreshFansFailed'),
        }
      }
      catch (error) {
        console.error('Refresh account fans failed:', error)
        return {
          platform,
          status: 'failed',
          kind: 'sync',
          message: t('channelManager.refreshFansFailed'),
        }
      }
    },
    [t],
  )

  const refreshSinglePlatform = useCallback(
    async (platform: PlatType): Promise<PlatformRefreshResult> => {
      const accounts = getPlatformAccounts(platform)
      if (accounts.length === 0) {
        return { platform, status: 'skipped', skippedReason: 'empty' }
      }

      if (!isPlatformFansRefreshSupported(platform, platformInfoMap.get(platform))) {
        return { platform, status: 'skipped', skippedReason: 'unsupported' }
      }

      const remainingMs = getPlatformRefreshRemaining(platform)
      if (remainingMs > 0) {
        return { platform, status: 'skipped', skippedReason: 'cooldown', remainingMs }
      }

      const result = isPluginFansRefreshPlatform(platform)
        ? await refreshPluginPlatform(platform, accounts)
        : await refreshAnalyticsPlatform(platform, accounts)

      if (isSuccessfulResult(result)) {
        markPlatformRefresh(platform)
      }
      else if (result.skippedReason === 'cooldown') {
        // 服务端明确回报仍在刷新间隔内：本地也记冷却，下一次点击直接短路，
        // 不再打接口（A10：冷却窗口内不得再打一次平台数据）。
        markPlatformRefresh(platform, result.remainingMs)
      }

      return result
    },
    [
      getPlatformAccounts,
      getPlatformRefreshRemaining,
      markPlatformRefresh,
      platformInfoMap,
      refreshAnalyticsPlatform,
      refreshPluginPlatform,
    ],
  )

  const notifyRefreshResults = useCallback(
    (results: PlatformRefreshResult[], isAllRefresh: boolean) => {
      const completedResults = results.filter(isSuccessfulResult)
      const failedResults = results.filter(result => result.status === 'failed')
      const cooldownResults = results.filter(result => result.skippedReason === 'cooldown')

      if (completedResults.length === 0) {
        if (cooldownResults.length > 0) {
          const firstCooldownResult = cooldownResults[0]
          const minutes = Math.ceil((firstCooldownResult.remainingMs || 0) / 60000)
          notification.warning(
            isAllRefresh
              ? t('channelManager.refreshFansAllCooldown', { minutes })
              : t('channelManager.refreshFansCooldown', {
                  platform: getPlatformName(firstCooldownResult.platform),
                  minutes,
                }),
          )
          return
        }

        const firstFailedResult = failedResults[0]
        notification.warning(firstFailedResult?.message || t('channelManager.refreshFansNoAvailableAccount'))
        return
      }

      if (failedResults.length > 0) {
        notification.warning(
          t('channelManager.refreshFansPartialDone', {
            platforms: formatPlatformNames(failedResults.map(result => result.platform)),
          }),
        )
        return
      }

      const syncPlatforms = completedResults
        .filter(result => result.kind === 'sync')
        .map(result => result.platform)
      const asyncPlatforms = completedResults
        .filter(result => result.kind === 'async')
        .map(result => result.platform)

      if (syncPlatforms.length > 0 && asyncPlatforms.length > 0) {
        notification.success(
          t('channelManager.refreshFansMixedDone', {
            syncPlatforms: formatPlatformNames(syncPlatforms),
          }),
        )
        return
      }

      if (syncPlatforms.length > 0) {
        notification.success(
          t('channelManager.refreshFansSyncDone', {
            platforms: formatPlatformNames(syncPlatforms),
          }),
        )
        return
      }

      notification.success(
        isAllRefresh
          ? t('channelManager.refreshFansAllSubmitted')
          : t('channelManager.refreshFansPlatformSubmitted', {
              platform: formatPlatformNames(asyncPlatforms),
            }),
      )
    },
    [formatPlatformNames, getPlatformName, t],
  )

  const refreshPlatformFans = useCallback(
    async (platform: PlatType) => {
      if (refreshingTarget)
        return

      setRefreshProgress(null)
      setRefreshingTarget(platform)
      try {
        const result = await refreshSinglePlatform(platform)
        notifyRefreshResults([result], false)
      }
      finally {
        setRefreshingTarget(null)
      }
    },
    [notifyRefreshResults, refreshSinglePlatform, refreshingTarget],
  )

  const refreshAllFans = useCallback(async () => {
    if (refreshingTarget)
      return

    if (refreshablePlatforms.length === 0) {
      notification.warning(t('channelManager.refreshFansNoAvailableAccount'))
      return
    }

    setRefreshingTarget('all')
    setRefreshProgress({ current: 0, total: refreshablePlatforms.length })
    try {
      const results: PlatformRefreshResult[] = []
      for (const [index, platform] of refreshablePlatforms.entries()) {
        results.push(await refreshSinglePlatform(platform))
        setRefreshProgress({ current: index + 1, total: refreshablePlatforms.length })
      }
      notifyRefreshResults(results, true)
    }
    finally {
      setRefreshingTarget(null)
      setRefreshProgress(null)
    }
  }, [notifyRefreshResults, refreshSinglePlatform, refreshablePlatforms, refreshingTarget, t])

  return {
    refreshingTarget,
    refreshProgress,
    refreshAllFans,
    refreshPlatformFans,
  }
}
