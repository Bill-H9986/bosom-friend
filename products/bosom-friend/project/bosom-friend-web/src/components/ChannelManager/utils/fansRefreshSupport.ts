import type { PlatformInfo } from '@web/api/channels/channel.types'
import type { PlatType } from '@web/app/config/platConfig'
import type { PluginPlatformType } from '@web/store/plugin'
import { PLUGIN_SUPPORTED_PLATFORMS } from '@web/store/plugin'

type PlatformFansRefreshInfo = Pick<PlatformInfo, 'capabilities'>

const pluginFansRefreshPlatformSet = new Set<PlatType>(PLUGIN_SUPPORTED_PLATFORMS)

export function isPluginFansRefreshPlatform(platform: PlatType): platform is PluginPlatformType {
  return pluginFansRefreshPlatformSet.has(platform)
}

export function isPlatformFansRefreshSupported(
  platform: PlatType,
  platformInfo?: PlatformFansRefreshInfo | null,
) {
  if (isPluginFansRefreshPlatform(platform))
    return true

  return platformInfo?.capabilities.analytics.account === true
}
