/**
 * ChannelManager - 频道管理弹窗组件
 *
 * 功能描述：
 * - 三页面视图：主页、连接频道列表、授权loading页
 * - 左侧频道类型侧边栏 + 右侧空间和账号管理
 * - 支持外部调用 openModal、openAndAuth 等方法
 * - 全局单例，挂载在根布局
 */

'use client'

import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@web/app/i18n/client'
import { useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@web/components/ui/dialog'
import { useAccountStore } from '@web/store/account'
import { useChannelManagerStore } from './channelManagerStore'
import { AuthLoadingPage } from './components/AuthLoadingPage'
import { ConnectChannelList } from './components/ConnectChannelList'
import { MainPage } from './components/MainPage'

export function ChannelManager() {
  const { t } = useTransClient('account')

  const { open, currentView, closeModal } = useChannelManagerStore(
    useShallow(state => ({
      open: state.open,
      currentView: state.currentView,
      closeModal: state.closeModal,
    })),
  )

  // 根据当前视图获取标题
  const getTitle = () => {
    switch (currentView) {
      case 'connect-list':
        return t('channelManager.connectNewChannel')
      case 'auth-loading':
        return t('channelManager.authInProgress')
      default:
        return t('channelManager.title')
    }
  }

  // 弹窗打开时确保账号/分组数据已加载：从导航等入口直接打开时，账号加载态未初始化会停在骨架屏（右侧粉丝刷新/新建分组不出现）。
  useEffect(() => {
    if (open) {
      void useAccountStore.getState().accountInit().catch(() => {})
    }
  }, [open])

  // 渲染当前视图
  const renderView = () => {
    switch (currentView) {
      case 'connect-list':
        return <ConnectChannelList />
      case 'auth-loading':
        return <AuthLoadingPage />
      default:
        return <MainPage />
    }
  }

  return (
    <Dialog open={open} onOpenChange={closeModal}>
      <DialogContent data-testid="channel-manager-dialog" className="flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col overflow-hidden border-border/70 bg-background p-0 shadow-2xl md:h-[744px] md:max-h-[calc(100dvh-32px)] md:max-w-[1160px] md:rounded-xl">
        {/* Header - 只在主页和连接列表页显示，auth-loading 时用 VisuallyHidden 保留无障碍标题 */}
        {currentView !== 'auth-loading' ? (
          <DialogHeader className="justify-center space-y-0 border-b border-border/70 bg-background px-6 py-4 md:min-h-[68px] md:px-7">
            <DialogTitle className="text-xl font-semibold tracking-tight text-foreground">{getTitle()}</DialogTitle>
          </DialogHeader>
        ) : (
          <VisuallyHidden>
            <DialogTitle>{getTitle()}</DialogTitle>
          </VisuallyHidden>
        )}

        {/* 内容区域 */}
        <div className="min-h-0 flex-1">{renderView()}</div>
      </DialogContent>
    </Dialog>
  )
}

// 导出store hook
export { useChannelManagerStore } from './channelManagerStore'

// 导出类型
export * from './types'

// 默认导出
export default ChannelManager
