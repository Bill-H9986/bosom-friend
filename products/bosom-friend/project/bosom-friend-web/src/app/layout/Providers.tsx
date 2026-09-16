/**
 * Providers - 全局 Provider 组件
 * 包含 Google OAuth、Ant Design 配置、Toast、主题等全局配置
 */

'use client'

import { ThemeProvider } from 'next-themes'
import { usePathname } from '@web/next-shims/navigation'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import SettingsModal from '@web/app/layout/SettingsModal'
import LoginDialog from '@web/app/layout/LoginDialog'
import { ChannelManager } from '@web/components/ChannelManager'
import { isPublicPage } from '@web/app/layout/shared/utils/routeUtils'
import { WechatBrowserOverlay } from '@web/components/common/WechatBrowserOverlay'
import { PluginPublishingFloatButton } from '@web/components/Plugin'
import NotificationCenter from '@web/components/ui/NotificationCenter'
import { Toaster } from '@web/components/ui/sonner'
import { useLoginDialogStore } from '@web/store/login-dialog'
import { usePlatformMetadataStore } from '@web/store/platformMetadata'
import { useSettingsModalStore } from '@web/store/settingsModal'
import { useUserStore } from '@web/store/user'
import { LOGIN_ENABLED } from '@web/config/auth'

const PublicRouteContext = createContext(false)

export function usePublicRoute() {
  return useContext(PublicRouteContext)
}

export function Providers({
  children,
  lng,
  autoLoginToken,
}: {
  children: React.ReactNode
  lng: string
  autoLoginToken?: string
}) {
  const pathname = usePathname()
  const publicRoute = isPublicPage(pathname)
  // 用于追踪是否已经在当前路由弹出过登录框，避免重复弹出
  const hasPromptedRef = useRef(false)
  const [authInitialized, setAuthInitialized] = useState(false)

  const { _hasHydrated, token } = useUserStore(
    useShallow(state => ({
      _hasHydrated: state._hasHydrated,
      token: state.token,
    })),
  )

  useEffect(() => {
    if (usePlatformMetadataStore.getState().loadedLng === lng)
      return
    usePlatformMetadataStore.getState().ensureLoaded(lng)
  }, [lng])

  // 全局设置弹框状态
  const { settingsVisible, settingsDefaultTab, closeSettings } = useSettingsModalStore()
  useEffect(() => {
    if (!_hasHydrated) {
      return
    }

    useUserStore.getState().appInit(autoLoginToken)
    setAuthInitialized(true)
  }, [_hasHydrated, autoLoginToken])

  // 账号体系守卫：无会话且不在公开页时唤起登录框（401 失效也会经 client.ts 再次唤起）
  useEffect(() => {
    if (!LOGIN_ENABLED || !authInitialized || token || publicRoute)
      return
    useLoginDialogStore.getState().openLoginDialog({ fromGuard: true })
  }, [authInitialized, token, publicRoute])

  useEffect(() => {
    useUserStore.getState().setLang(lng)
  }, [lng])

  // 桌面端登录就绪后，把本地历史发布记录回填到数据统计（一次性、幂等）
  useEffect(() => {
    if (!_hasHydrated || !authInitialized || !token) {
      return
    }
    const ipc = typeof window === 'undefined' ? null : (window as any).ipcRenderer
    if (!ipc || ipc.__zyShim === true) {
      return
    }
    ipc.invoke('ICP_PUBLISH_SYNC_RECORDS').catch(() => {})
  }, [_hasHydrated, authInitialized, token])

  // 内测免登录模式：登录守卫整体移除——永不弹登录框、不跳登录页
  // （登录 UI 已按产品要求移除，将来恢复登录功能时再启用）

  // 拦截 @react-oauth/google 的脚本加载，添加 ?hl= 参数以设置按钮语言
  return (
    <PublicRouteContext.Provider value={publicRoute}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
        <Toaster position="top-center" richColors />
          {/* 专用右上角通知中心（不影响现有 toast） */}
          <NotificationCenter />
          <PluginPublishingFloatButton />
          <WechatBrowserOverlay />
          {/* 全局设置弹框 - 统一在此渲染，避免多处重复 */}
          <SettingsModal
            open={settingsVisible}
            onClose={closeSettings}
            defaultTab={settingsDefaultTab}
          />
          {/* 全局登录弹框（账号体系守卫入口；LOGIN_ENABLED=false 时屏蔽） */}
          {LOGIN_ENABLED && <LoginDialog />}
          {/* 全局频道管理弹框（添加频道/账号授权统一入口） */}
          <ChannelManager />
          {children}
      </ThemeProvider>
    </PublicRouteContext.Provider>
  )
}
