/**
 * 平台授权 Hook
 * 处理各平台的授权跳转逻辑
 */

import type { SocialAccount } from '@web/api/accounts/account.types'

import { useCallback } from 'react'
import { useChannelManagerStore } from '@web/components/ChannelManager/channelManagerStore'
import { usePublishDialog } from '@web/components/PublishDialog/usePublishDialog'

/**
 * 平台授权 Hook
 */
export function usePlatformAuth() {
  const setOnAuthSuccess = useChannelManagerStore(state => state.setOnAuthSuccess)
  const startAuth = useChannelManagerStore(state => state.startAuth)

  /**
   * 处理离线账户头像点击，复用频道管理授权流程
   */
  const handleOfflineAvatarClick = useCallback(
    (account: SocialAccount) => {
      setOnAuthSuccess((authedAccount) => {
        usePublishDialog.getState().syncAccounts([
          ...usePublishDialog.getState().pubList.map(pubItem => pubItem.account),
          authedAccount,
        ])
        useChannelManagerStore.getState().setOnAuthSuccess(null)
      })
      startAuth(account.type, account.groupId)
    },
    [setOnAuthSuccess, startAuth],
  )

  return {
    handleOfflineAvatarClick,
  }
}
