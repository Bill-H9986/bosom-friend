/**
 * WebAppLayout - 桌面端 Web 布局壳
 * 使用 Web 端源代码的官网同款布局（LayoutSidebar + MainContent + AI 助手），
 * 保留 Electron 本地能力（网络横幅、账号初始化、开发工具快捷键）。
 */
'use client'

import LayoutSidebar from '@web/app/layout/LayoutSidebar'
import { MainContent } from '@web/app/layout/MainContent'
import { Providers } from '@web/app/layout/Providers'
import { AIAssistantPanel } from '@web/components/AIAssistantPanel'
import { Outlet, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useNavigationLogic } from '@web/app/layout/shared'
import { useUserStore as useWebUserStore } from '@web/store/user'
import { useLlmConfigStore } from '@web/store/llmConfig'
import { useAiAssistantStore } from '@web/store/aiAssistant'
import { ZHINYIN_OPEN_CHAT_EVENT, parseOpenAiChatEvent } from '@web/utils/bosomFriendAssistant'
import { DisclaimerModal } from '@web/components/DisclaimerModal'
import { PublishDialogHost } from '@web/components/PublishDialog/PublishDialogHost'
import { useAgentStore } from '@web/store/agent'
import Update from '@/components/update'
import { loadUserLlm } from '@web/utils/userLlm'
import http from '@web/utils/request'

export function WebAppLayout() {

  // 随包后端冷启动指示：窗口先开、服务后到。用非阻塞胶囊告知「服务启动中」，
  // 任一信号（backend:ready 事件 / 用户信息成功落地）即消失，避免无限转圈感。
  const userInfo = useWebUserStore(state => state.userInfo)
  const [backendStarting, setBackendStarting] = useState(
    () => typeof window !== 'undefined' && !!window.ipcRenderer,
  )

  // 兜底轮询：若 ready 事件早于监听器挂载（快速热启动）被错过，
  // 周期性重试初始化；一旦 userInfo 落地即认为服务可用。
  useEffect(() => {
    if (!backendStarting)
      return
    if (userInfo && Object.keys(userInfo).length > 0) {
      setBackendStarting(false)
      return
    }
    const timer = setInterval(() => {
      useWebUserStore.getState().appInit()
    }, 6000)
    return () => clearInterval(timer)
  }, [backendStarting, userInfo])

  // 初始化 Web 端用户会话：优先使用主进程注入的持久化登录 token
  // （打包版没有开发模式模拟账号，不注入会被登录弹窗卡死）
  useEffect(() => {
    const autoLoginToken = typeof window !== 'undefined'
      ? (window as any).__ZHIYIN_AUTH_TOKEN__ || undefined
      : undefined
    useWebUserStore.getState().appInit(autoLoginToken)
    // 全局大模型配置：应用启动即加载（自定义大模型激活后全系统生效）
    useLlmConfigStore.getState().load()
    // 模型配置的唯一权威在服务端 llm-user.json（设置页保存时写入，并投影给内核）。
    // 历史版本每次启动都把浏览器副本整份 PUT 回去，一次局部同步就会冲掉设置页配好的多服务配置；
    // 现在只在服务端**还没有任何配置**时做一次迁移，之后浏览器副本只用于回填密钥。
    const localLlm = loadUserLlm()
    if (localLlm) {
      // 注意 @web/utils/request 返回的是完整信封 { code, data, message }：
      // 读成 remote.providers 会恒为空，于是每次启动都误判"服务端没配置"、把旧副本灌回去。
      // 注意 @web/utils/request 返回的是完整信封 { code, data, message }：
      // 读成 remote.providers 会恒为空，于是每次启动都误判"服务端没配置"、把旧副本灌回去。
      void http.get<{ providers?: unknown[] }>('ai/user-llm', undefined, true).then((remote) => {
        const payload = (remote as { data?: { providers?: unknown[] } } | null)?.data
        const providers = Array.isArray(payload?.providers) ? payload.providers : []
        if (providers.length === 0)
          void http.put('ai/user-llm', localLlm, true)
      }).catch(() => {
        // 读不到服务端配置时不动它：宁可不迁移，也不覆盖服务端已有配置。
      })
    }

    // 右侧 AI 助手 = 临时会话：每次启动 APP 自动清理（新启动清空本地缓存，
    // 本次运行内刷新保留当前对话）；长期对话数据保存在后端「任务记录」中，
    // 需要时从任务记录重新进入即可查看完整历史。
    useAgentStore.getState().initTempSession()
  }, [])

  // 响应 Agent 控制指令（统一指令契约）：唤起右侧 AI 助手面板并预填问题
  useEffect(() => {
    const openAiChat = (event: Event) => {
      const command = parseOpenAiChatEvent(event)
      if (!command)
        return
      useAiAssistantStore.getState().setCollapsed(false)
      useAiAssistantStore.getState().setPendingPrompt(command.message)
    }
    window.addEventListener(ZHINYIN_OPEN_CHAT_EVENT, openAiChat)
    return () => window.removeEventListener(ZHINYIN_OPEN_CHAT_EVENT, openAiChat)
  }, [])

  // 随包后端在后台启动；后端就绪后重试一次用户信息 / 账号初始化，
  // 避免“窗口秒开但后端还没起”导致首屏用户数据拉空。
  useEffect(() => {
    const onBackendReady = () => {
      useWebUserStore.getState().appInit()
      setBackendStarting(false)
    }
    if (typeof window !== 'undefined' && window.ipcRenderer && (window.ipcRenderer as unknown as { __zyShim?: boolean }).__zyShim !== true) {
      window.ipcRenderer.on('zhiyin:backend:ready', onBackendReady)
      return () => {
        window.ipcRenderer?.off('zhiyin:backend:ready', onBackendReady)
      }
    }
  }, [])

  // 测试阶段提示已并入「平台免责声明」，不再单独弹出

  const { isAuthPage } = useNavigationLogic()
  const location = useLocation()

  return (
    <Providers lng="zh-CN">
      {/* OTA 升级弹窗：监听主进程更新事件（按钮入口在「设置 → 系统与更新」） */}
      <Update hideButton />
      <div className="relative flex h-screen w-full bg-background text-foreground">
        {/* 全宽顶部主题色渐变：横贯左侧边栏、主内容区与右侧 AI 面板，高度统一、常驻顶部不随滚动切断 */}
        {!isAuthPage && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-32 bg-gradient-to-b from-primary/30 via-primary/12 to-transparent"
          />
        )}
        {/* 官网同款左侧边栏 */}
        <LayoutSidebar />

        {/* 主内容区域 */}
        <MainContent>
          <div key={location.pathname} className="page-enter h-full w-full">
            <Outlet />
          </div>
        </MainContent>

        {/* 右侧 AI 助手侧边栏 */}
        <AIAssistantPanel />

        {/* 本地服务启动指示（随包后端冷启动期间的诚实告知） */}
        {backendStarting && (
          <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-border/60 bg-background/85 px-4 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            本地服务启动中，数据将在就绪后自动加载…
          </div>
        )}

        {/* 首次启动免责声明（确认后不再弹出） */}
        <DisclaimerModal />

        {/* 全应用唯一的发布弹窗宿主：内容创作 / 账号日历 / AI 批量都复用它 */}
        <PublishDialogHost />

      </div>
    </Providers>
  )
}

export default WebAppLayout
