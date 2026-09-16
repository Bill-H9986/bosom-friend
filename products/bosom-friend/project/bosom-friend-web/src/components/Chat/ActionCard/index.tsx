/**
 * ActionCard - Action 卡片组件
 * 用于在聊天消息中显示可交互的 action 卡片
 * 支持：连接频道、更新授权、跳转发布等
 */

'use client'

import type { IActionCard } from '@web/store/agent/agent.types'
import { AlertCircle, ArrowRight, Compass, CreditCard, Link2, RefreshCw, Send } from 'lucide-react'
import { useParams, usePathname, useRouter } from '@web/next-shims/navigation'
import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@web/app/i18n/client'
import { useChannelManagerStore } from '@web/components/ChannelManager'
import { Button } from '@web/components/ui/button'
import { useAccountStore } from '@web/store'
import { useAgentStore } from '@web/store/agent'
import { ActionRegistry } from '@web/store/agent/handlers/action.handlers'
import { PluginStatus, usePluginStore } from '@web/store/plugin'
import { useUserStore } from '@web/store/user'
import { isDesktopEnv } from '@web/components/ChannelManager/utils/desktopLogin'
import { navigateToLogin } from '@web/utils/auth'
import { cn } from '@web/utils/className'
import { shouldUseDesktopPublish } from '@web/utils/publish/desktopRoute'
import { toast } from '@web/utils/ui/toast'
import { executeAgentNavigateAction, executeAgentPublishAction } from './executePublishAction'

/** 导航动作的中文名，用于卡片标题与「立即前往」提示。 */
const NAVIGATE_LABELS: Record<string, string> = {
  navigateToDraft: '草稿箱',
  navigateToDatacenter: '数据中心',
  navigateToMonitor: '全局监控',
  navigateToReception: 'AI 互动接待',
  navigateToKnowledge: '知识库',
  navigateToCalendar: '发布日历',
  navigateToTasks: '任务历史',
}

export interface IActionCardProps {
  /** Action 数据 */
  action: IActionCard
  /** 自定义类名 */
  className?: string
}

/** 平台名称映射 */
const PLATFORM_NAMES: Record<string, string> = {
  douyin: '抖音',
  xhs: '小红书',
  wxSph: '微信视频号',
  KWAI: '快手',
  youtube: 'YouTube',
  wxGzh: '微信公众号',
  bilibili: 'Bilibili',
  twitter: 'Twitter',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  pinterest: 'Pinterest',
  linkedin: 'LinkedIn',
}

/** 获取平台显示名称 */
function getPlatformDisplayName(platform?: string): string {
  if (!platform)
    return 'Platform'
  return PLATFORM_NAMES[platform] || platform.charAt(0).toUpperCase() + platform.slice(1)
}

/** Action 卡片配置 */
interface IActionConfig {
  icon: React.ReactNode
  title: string
  description: string
  buttonText: string
  bgClass: string
  borderClass: string
  iconClass: string
}

/**
 * ActionCard - 渲染单个 Action 卡片
 */
export function ActionCard({ action, className }: IActionCardProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { lng } = useParams()
  const { t } = useTransClient('chat')
  const token = useUserStore(state => state.token)

  // Agent store 方法
  const { continueTask } = useAgentStore()

  // 频道管理器
  const { openConnectList, setOnAuthSuccess, closeModal } = useChannelManagerStore(
    useShallow(state => ({
      openConnectList: state.openConnectList,
      setOnAuthSuccess: state.setOnAuthSuccess,
      closeModal: state.closeModal,
    })),
  )

  const platformName = getPlatformDisplayName(action.platform)

  // 根据 action 类型获取配置
  const getActionConfig = (): IActionConfig | null => {
    switch (action.type) {
      case 'insufficientCredits':
        return {
          icon: <CreditCard className="w-5 h-5" />,
          title: t('action.insufficientCredits') || '积分不足',
          description: t('action.insufficientCreditsDesc') || '任务已暂停，请充值积分后继续。',
          buttonText: t('action.rechargeCredits') || '充值积分',
          bgClass:
            'bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/30',
          borderClass: 'border-amber-200 dark:border-amber-800',
          iconClass: 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/50',
        }
      case 'errorOnly':
        return {
          icon: <AlertCircle className="w-5 h-5" />,
          title: action.title || t('action.error') || '生成失败',
          description: action.description || t('action.errorDesc') || '生成失败，请稍后重试。',
          buttonText: '',
          bgClass:
            'bg-gradient-to-br from-rose-50 to-pink-50 dark:from-rose-950/30 dark:to-pink-950/30',
          borderClass: 'border-rose-200 dark:border-rose-800',
          iconClass: 'text-rose-600 dark:text-rose-400 bg-rose-100 dark:bg-rose-900/50',
        }
      case 'createChannel':
        return {
          icon: <Link2 className="w-5 h-5" />,
          title: t('action.addChannel') || 'Add Channel',
          description:
            t('action.addChannelDesc', { platform: platformName })
            || `You haven't connected a ${platformName} account yet. Please add a channel to publish content.`,
          buttonText: t('action.addChannelNow') || 'Add Channel',
          bgClass:
            'bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30',
          borderClass: 'border-blue-200 dark:border-blue-800',
          iconClass: 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/50',
        }
      case 'updateChannel':
        return {
          icon: <RefreshCw className="w-5 h-5" />,
          title: t('action.updateAuth') || '更新授权',
          description:
            t('action.updateAuthDesc', { platform: platformName })
            || `${platformName} 账号授权已过期，请重新授权`,
          buttonText: t('action.reauthorize') || '重新授权',
          bgClass:
            'bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30',
          borderClass: 'border-amber-200 dark:border-amber-800',
          iconClass: 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/50',
        }
      case 'loginChannel':
        return {
          icon: <AlertCircle className="w-5 h-5" />,
          title: t('action.loginChannel') || '登录频道',
          description:
            t('action.loginChannelDesc', { platform: platformName })
            || `请先登录 ${platformName} 账号`,
          buttonText: t('action.goLogin') || '去登录',
          bgClass:
            'bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-950/30 dark:to-pink-950/30',
          borderClass: 'border-purple-200 dark:border-purple-800',
          iconClass: 'text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/50',
        }
      case 'navigateToPublish':
        return {
          icon: <Send className="w-5 h-5" />,
          title: t('action.readyToPublish') || '准备发布',
          description:
            t('action.readyToPublishDesc', { platform: platformName })
            || `内容已准备好，可以发布到 ${platformName}`,
          buttonText: t('action.goPublish') || '去发布',
          bgClass:
            'bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30',
          borderClass: 'border-green-200 dark:border-green-800',
          iconClass: 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/50',
        }
      // 导航类动作：智能体只用一句对话就能把用户带到各个功能页（AC-018-1）。
      // 这张卡必须可见可点：以前只有 navigateToPublish 有分支，其余导航动作渲染成空节点，
      // 用户看着智能体说「已为你打开」却找不到任何按钮。
      case 'navigateToDraft':
      case 'navigateToDatacenter':
      case 'navigateToMonitor':
      case 'navigateToReception':
      case 'navigateToKnowledge':
      case 'navigateToCalendar':
      case 'navigateToTasks':
        return {
          icon: <Compass className="w-5 h-5" />,
          title: action.title || NAVIGATE_LABELS[action.type] || '为你打开功能页',
          description: action.description || '点击即可前往该功能页。',
          buttonText: '立即前往',
          bgClass:
            'bg-gradient-to-br from-sky-50 to-blue-50 dark:from-sky-950/30 dark:to-blue-950/30',
          borderClass: 'border-sky-200 dark:border-sky-800',
          iconClass: 'text-sky-600 dark:text-sky-400 bg-sky-100 dark:bg-sky-900/50',
        }
      default:
        return null
    }
  }

  const config = getActionConfig()

  /**
   * 处理账号添加成功 - 用于 ChannelManager 回调
   */
  const handleAccountAddSuccess = useCallback(async () => {
    // 清除回调
    setOnAuthSuccess(null)

    closeModal()

    // 检查是否在 chat 页面
    if (pathname.includes('/chat/')) {
      // 提取 taskId
      const pathParts = pathname.split('/')
      const taskIdIndex = pathParts.findIndex(part => part === 'chat')
      if (taskIdIndex !== -1 && pathParts[taskIdIndex + 1]) {
        const taskId = pathParts[taskIdIndex + 1]

        // 自动发送消息
        const platformDisplayName = getPlatformDisplayName(action.platform)
        const autoMessage = `I have added the "${platformDisplayName}" channel account, please continue.`

        try {
          await continueTask({
            prompt: autoMessage,
            medias: [],
            t: t as (key: string) => string,
            taskId,
          })
        }
        catch (error) {
          console.error('Auto send message failed:', error)
        }
      }
    }
  }, [pathname, action.platform, continueTask, t, setOnAuthSuccess])

  /**
   * 打开频道管理器并设置成功回调
   */
  const openChannelManager = useCallback(() => {
    // 设置授权成功回调
    setOnAuthSuccess(handleAccountAddSuccess)
    // 打开频道管理器
    openConnectList()
  }, [setOnAuthSuccess, handleAccountAddSuccess, openConnectList])

  // 处理按钮点击
  const handleClick = () => {
    const platform = action.platform || ''

    switch (action.type) {
      case 'insufficientCredits':
        useAccountStore.getState().setLowBalanceAlertOpen(true)
        return
      case 'createChannel':
        // 未登录时跳转登录页
        if (!token) {
          toast.warning(t('home.loginRequired') || 'Please login first')
          navigateToLogin()
          return
        }
        // 打开频道管理器
        openChannelManager()
        break
      case 'updateChannel':
        router.push(`/${lng}/accounts?updateChannel=${platform}`)
        break
      case 'loginChannel':
        router.push(`/${lng}/accounts?loginChannel=${platform}`)
        break
      case 'navigateToPublish': { // 构建发布参数
        // 普通 Web / 后端账号模式：把 AI 生成内容转成草稿并打开发布弹窗，
        // 不再要求浏览器插件；真实发布由后端 Chrome 引擎完成。
        if (!shouldUseDesktopPublish(platform, isDesktopEnv())) {
          executeAgentPublishAction(action, router)
          return
        }

        // 浏览器环境才走插件授权；Electron 桌面端直接进入发布弹窗，由本地内核发布。
        if ((platform === 'xhs' || platform === 'douyin') && !shouldUseDesktopPublish(platform, isDesktopEnv())) {
          const pluginStatus = usePluginStore.getState().status
          if (pluginStatus === PluginStatus.READY) {
            // 插件已就绪，使用 ActionRegistry 执行发布
            ActionRegistry.execute(
              {
                type: 'fullContent',
                action: 'navigateToPublish',
                platform: action.platform,
                accountId: action.accountId,
                title: action.title,
                description: action.description,
                medias: action.medias,
                tags: action.tags,
              },
              { router, lng: lng as string, t },
            )
            return
          }
          else {
            // 插件未就绪，提示用户
            toast.warning(t('plugin.platformNeedsPlugin') || '该平台需要安装插件才能发布')
            return
          }
        }
        // 非插件平台，保持原有逻辑
        const params = new URLSearchParams()
        params.set('action', 'publish')
        params.set('aiGenerated', 'true')
        if (platform)
          params.set('platform', platform)
        if (action.accountId)
          params.set('accountId', action.accountId)
        if (action.title)
          params.set('title', action.title)
        if (action.description)
          params.set('description', action.description)
        if (action.tags?.length)
          params.set('tags', JSON.stringify(action.tags))
        if (action.medias?.length)
          params.set('medias', JSON.stringify(action.medias))
        router.push(`/${lng}/accounts?${params.toString()}`)
        break
      }
      // 导航类动作直接跳转，不落到「账号页」这个兜底分支。
      case 'navigateToDraft':
      case 'navigateToDatacenter':
      case 'navigateToMonitor':
      case 'navigateToReception':
      case 'navigateToKnowledge':
      case 'navigateToCalendar':
      case 'navigateToTasks':
        executeAgentNavigateAction(action, router)
        return
      default:
        router.push(`/${lng}/accounts`)
    }
  }

  return (
    <>
      {
        config ? (
          <div
            data-action-card={action.type}
            className={cn(
              'rounded-xl border p-4 transition-all hover:shadow-md',
              config.bgClass,
              config.borderClass,
              className,
            )}
          >
            {/* 头部：图标 + 标题 */}
            <div className="flex items-center gap-3 mb-3">
              <div className={cn('p-2 rounded-lg', config.iconClass)}>{config.icon}</div>
              <div className="flex-1">
                <h4 className="font-semibold text-foreground">{config.title}</h4>
                {action.platform && <span className="text-xs text-muted-foreground">{platformName}</span>}
              </div>
            </div>

            {/* 描述 */}
            <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{config.description}</p>

            {/* 操作按钮：errorOnly 不显示按钮 */}
            {action.type !== 'errorOnly' && (
              <Button onClick={handleClick} className="w-full group" variant="default">
                {config.buttonText}
                <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
              </Button>
            )}
          </div>
        ) : <></>
      }
    </>

  )
}

export default ActionCard
