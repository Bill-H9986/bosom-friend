import type { PluginPlatformType } from './types/baseTypes'
import type { PlatAccountInfo } from './types/plat.type'
import type { SocialAccount } from '@web/api/accounts/account.types'
import { AccountStatus } from '@web/app/config/accountConfig'
import { PlatType } from '@web/app/config/platConfig'
import { PLUGIN_SUPPORTED_PLATFORMS } from './types/baseTypes'
import { isDesktopEnv } from '@web/components/ChannelManager/utils/desktopLogin'

export type PluginAccountStatusMap = Partial<Record<PluginPlatformType, PlatAccountInfo | null>>

export function isPluginSupportedPlatform(platform: PlatType): platform is PluginPlatformType {
  return PLUGIN_SUPPORTED_PLATFORMS.includes(platform as PluginPlatformType)
}

export function getXhsLoginStatus(account?: PlatAccountInfo | null) {
  if (!account || account.type !== PlatType.Xhs) {
    return null
  }

  return account.xhsLoginStatus ?? null
}

export function getWxSphLoginStatus(account?: PlatAccountInfo | null) {
  if (!account || account.type !== PlatType.WxSph) {
    return null
  }

  return account.wxSphLoginStatus ?? null
}
export function isPluginPlatformAccountReady(account?: PlatAccountInfo | null): account is PlatAccountInfo {
  if (!account) {
    return false
  }

  const xhsLoginStatus = getXhsLoginStatus(account)
  if (xhsLoginStatus) {
    return xhsLoginStatus.home && xhsLoginStatus.creator
  }

  const wxSphLoginStatus = getWxSphLoginStatus(account)
  if (wxSphLoginStatus) {
    return wxSphLoginStatus.channels
  }

  return true
}

/** 浏览器插件 API 是否完整存在；纯 Web / 垫片对象都不能视为插件已安装。 */
function hasPluginApi(): boolean {
  return typeof window !== 'undefined'
    && !!window.ZhiyinPlugin
    && typeof window.ZhiyinPlugin.checkPermission === 'function'
}

export function mergePluginAccountStatus(
  accountList: SocialAccount[],
  platformAccounts: PluginAccountStatusMap,
) {
  const accountMap = new Map<string, SocialAccount>()

  // 桌面端或纯浏览器端没有可用的插件 API：账号状态一律以后端/本地会话判定为准，
  // 插件快照（恒为未登录）绝不能把正常账号覆盖成「离线」。
  if (isDesktopEnv() || !hasPluginApi()) {
    accountList.forEach((account) => {
      accountMap.set(account.id, account)
    })
    return {
      accountList,
      accountMap,
    }
  }

  const mergedAccountList = accountList.map((account) => {
    if (!isPluginSupportedPlatform(account.type)) {
      accountMap.set(account.id, account)
      return account
    }

    if (!Object.hasOwn(platformAccounts, account.type)) {
      accountMap.set(account.id, account)
      return account
    }

    const platformAccount = platformAccounts[account.type]
    const shouldBeOnline = !!platformAccount
      && isPluginPlatformAccountReady(platformAccount)
      && platformAccount.uid === account.uid
    const status = shouldBeOnline ? AccountStatus.USABLE : AccountStatus.DISABLE
    const mergedAccount = account.status === status ? account : { ...account, status }

    accountMap.set(mergedAccount.id, mergedAccount)
    return mergedAccount
  })

  return {
    accountList: mergedAccountList,
    accountMap,
  }
}
