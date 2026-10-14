/**
 * ActionCard - Action 卡片组件
 * 用于在聊天消息中显示可交互的 action 卡片
 * 支持：连接频道、更新授权、跳转发布等
 */

'use client'

import type { IActionCard } from '@web/store/agent/agent.types'
import { AlertCircle, ArrowRight, Compass, CreditCard, Link2, PenLine, RefreshCw, Save, Send } from 'lucide-react'
import { useParams, usePathname, useRouter } from '@web/next-shims/navigation'
import { useCallback, useState } from 'react'
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
import type { TaskActionResult } from '@web/api/ai/ai.types'
import { FailureActions } from '@web/components/Chat/FailureActions'
import { ActionStateRow, useActionResults } from './ActionResultsContext'
import { executeAgentNavigateAction, executeAgentPublishAction, executeAgentSaveDraftAction, executeAgentUpdateDraftAction } from './executePublishAction'

/**
 * 从当前路由取聊天任务 id；不在聊天页时返回 undefined。
 *
 * 两条路由都要认：Web 端是 `/[lng]/chat/<taskId>`（pathname），桌面壳是 hash 路由
 * `#/chat/<taskId>`（pathname 里根本没有 chat 段）。只读 pathname 时，桌面端永远取不到
 * taskId → 动作执行完的回填被静默跳过 → 任务里那张卡永远停在「已申请」
 * （2026-10-11 实测：同一批任务在桌面端点过"存进草稿箱"，`actionResults` 依然是空）。
 */
function pathTaskId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const hashPath = window.location.hash.replace(/^#/, '')
  const source = hashPath.includes('/chat/') ? hashPath : window.location.pathname
  const parts = source.split('/').filter(Boolean)
  const index = parts.findIndex(part => part === 'chat')
  if (index === -1) return undefined
  // `/chat/new` 上还没有真实任务：这时回填无处可写，直接当作拿不到。
  const taskId = parts[index + 1]
  return taskId === undefined || taskId === '' || taskId === 'new' ? undefined : taskId
}

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
  /**
   * 这条动作属于哪条任务。
   *
   * 缺省时按当前 URL 取（聊天页 `/chat/<taskId>`）；管家团队页不在聊天路由上，
   * 必须由调用方传进来，否则执行完的回填（DEF-248 的「已申请 → 已执行」）没有落点，
   * 卡片会永远停在「未回填」。
   */
  taskId?: string
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
export function ActionCard({ action, taskId, className }: IActionCardProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { lng } = useParams()
  // 桌面壳是 hash 路由（路由表没有 [lng] 段），useParams() 拿不到 lng：此时必须拼空前缀，
  // 否则路径成了 /undefined/accounts，落到路由兜底被送回首页——用户看到的就是「点了没反应」。
  const lngPrefix = lng ? `/${lng}` : ''
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
      // 存草稿 / 改写草稿：内核只登记参数，真正的动作由前端执行（产品铁律 #2）。
      case 'saveDraft':
        return {
          icon: <Save className="w-5 h-5" />,
          title: action.title || '准备存草稿',
          description: action.description ? action.description.slice(0, 60) : '把这条内容写进草稿箱。',
          buttonText: '存进草稿箱',
          bgClass: 'bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/30',
          borderClass: 'border-violet-200 dark:border-violet-800',
          iconClass: 'text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/50',
        }
      case 'updateDraft':
        return {
          icon: <PenLine className="w-5 h-5" />,
          title: action.title || '准备改写草稿',
          description: '把 AI 改好的标题 / 正文写回这条草稿。',
          buttonText: '写回草稿',
          bgClass: 'bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-950/30 dark:to-cyan-950/30',
          borderClass: 'border-teal-200 dark:border-teal-800',
          iconClass: 'text-teal-600 dark:text-teal-400 bg-teal-100 dark:bg-teal-900/50',
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
   * 这张卡说的那件事是不是**已经做完了**（DEF-270）。
   *
   * 两条依据都来自服务端、不是推测：
   * ① 卡片自带 `state: 'executed'` —— 内核工具已经落库（`bosom_content_create_draft` 经回环 HTTP
   *    真写进草稿箱并回传真实 id），服务端据此把卡标成已执行；
   * ② 本任务的动作回填台账里有这条工单的 executed / verified 记录。
   * 满足任一条就不再给出执行按钮：再点一次会写出**第二条草稿**，那正是"助手说存好了、
   * 卡片说没回填、草稿箱却 +1"的来源。
   */
  const actionResults = useActionResults()
  const draftAlreadyDone
    = (action.type === 'saveDraft' || action.type === 'updateDraft')
      && (
        action.state === 'executed'
        || (
          action.requestId !== undefined
          && action.requestId !== ''
          && (actionResults ?? []).some(
            item => item.requestId === action.requestId && (item.state === 'executed' || item.state === 'verified'),
          )
        )
      )
  /** 卡片自述的执行结论：台账快照里还查不到时（实时这一轮刚写完），状态行据此显示「已执行」。 */
  const declaredResult: TaskActionResult | undefined
    = action.state === 'executed' && action.requestId !== undefined && action.requestId !== ''
      ? {
          requestId: action.requestId,
          state: 'executed',
          realId: action.draftId ?? '',
          note: action.type === 'updateDraft' ? '草稿已写回' : '草稿已写入草稿箱',
          at: '',
        }
      : undefined

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

  /**
   * 失败态三选择（BFS-104.4 / 方案 M8）。
   *
   * 这条链路此前**根本没有出口**：服务端在 SSE 里报错时写一张 `errorOnly` 卡
   * （`store/agent/task-instance/sse.handler.ts` 的 title 就是「生成失败」），
   * 而卡片的渲染分支明确写着"errorOnly 不显示按钮"——用户只看到一行红字，
   * 什么也点不了。三个选择就在这里补齐。
   *
   * - 断点继续：把用户那句话接着发给同一个任务（已跑成的步骤不会重跑）；
   * - 重新生成：另起一条任务，用同一句话重来（旧任务留着便于对照）；
   * - 放弃：收起这张失败卡（记录仍在任务记录里）。
   *
   * 原始那句话从 store 里"本条任务最后一条用户消息"取；取不到就不显示按钮，
   * 不给一个点了没反应的入口。
   */
  const [failureBusy, setFailureBusy] = useState(false)
  const [failureDismissed, setFailureDismissed] = useState(false)
  /**
   * 这条失败属于哪条任务。
   *
   * 三级回退，都是**读出来的事实**，不是猜的：
   * ① 调用方显式传的（团队页不在聊天路由上，必须传）；
   * ② 当前 URL 里的 `#/chat/<taskId>`；
   * ③ store 里的当前任务 id——`/chat/new` 上刚发起的任务 URL 还是 `new`，
   *    但 store 已经拿到真实 id 了，没有这一级「断点继续」在首屏永远出不来。
   */
  const storeCurrentTaskId = useAgentStore(state => state.currentTaskId)
  const failureTaskId = taskId ?? pathTaskId() ?? (storeCurrentTaskId === null || storeCurrentTaskId === undefined || storeCurrentTaskId === '' ? undefined : String(storeCurrentTaskId))
  /**
   * 用户那句话。
   *
   * 先按本条任务找；找不到（`/chat/new` 上还没有真实任务 id，或 id 是新建的临时值）
   * 就退到"当前会话里最后一条用户消息"——**不猜**：再取不到就只有「放弃」这一个出口，
   * 宁可少给一个按钮，也不给一个点了没反应的按钮。
   */
  const lastUserPrompt = useAgentStore((state) => {
    const pickLast = (id: string | undefined): string => {
      if (id === undefined) return ''
      const messages = state.taskMessages[id]?.messages ?? []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user') return messages[index].content ?? ''
      }
      return ''
    }
    const scoped = pickLast(failureTaskId)
    if (scoped !== '') return scoped
    for (const bucket of Object.values(state.taskMessages)) {
      const messages = bucket?.messages ?? []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user') return messages[index].content ?? ''
      }
    }
    return ''
  })

  const runFailureAction = async (kind: 'continue' | 'regenerate', prompt: string) => {
    if (prompt.trim() === '' || failureBusy) return
    setFailureBusy(true)
    try {
      if (kind === 'continue' && failureTaskId !== undefined) {
        await continueTask({
          prompt,
          medias: [],
          t: t as (key: string) => string,
          taskId: failureTaskId,
        })
      }
      else {
        await useAgentStore.getState().createTask({
          prompt,
          medias: [],
          t: t as (key: string) => string,
        })
      }
    }
    catch {
      toast.error(kind === 'continue' ? '继续失败，稍后再试一次' : '重新生成失败，稍后再试一次')
    }
    finally {
      setFailureBusy(false)
    }
  }

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
        router.push(`${lngPrefix}/accounts?updateChannel=${platform}`)
        break
      case 'loginChannel':
        router.push(`${lngPrefix}/accounts?loginChannel=${platform}`)
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
        router.push(`${lngPrefix}/accounts?${params.toString()}`)
        break
      }
      // 存草稿 / 改写草稿：全在前端执行，不经过任何后端写路径。
      case 'saveDraft':
        // 已经写进草稿箱的卡不再执行第二次（DEF-270）：按钮此时也不显示，
        // 这道防御是给"按钮之外还摸得到这个分支"的路径留的（键盘、未来新增的自动执行）。
        if (draftAlreadyDone || action.state === 'executed') {
          toast.success('这条已经写进草稿箱了')
          return
        }
        void executeAgentSaveDraftAction(action, taskId ?? pathTaskId()).then((ok) => {
          if (ok) toast.success('已存进草稿箱')
          else toast.error('存草稿失败：内容为空或接口报错')
        })
        return
      case 'updateDraft':
        if (draftAlreadyDone || action.state === 'executed') {
          toast.success('这条草稿已经写回过了')
          return
        }
        void executeAgentUpdateDraftAction(action, taskId ?? pathTaskId()).then((ok) => {
          if (ok) toast.success('已写回草稿')
          else toast.error('改写失败：缺少草稿 id 或内容为空')
        })
        return
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
        router.push(`${lngPrefix}/accounts`)
    }
  }

  return (
    <>
      {
        config ? (
          (action.type === 'errorOnly' && failureDismissed) ? <></> : (
          <div
            data-action-card={action.type}
            data-testid={`action-card-${action.type}`}
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

            {/* 操作按钮：errorOnly 不显示按钮；已经做完的草稿卡也不显示（再点一次会写第二条） */}
            {action.type !== 'errorOnly' && !draftAlreadyDone && (
              <Button onClick={handleClick} className="w-full group" variant="default">
                {config.buttonText}
                <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
              </Button>
            )}

            {/* 失败态三选择（BFS-104.4）：errorOnly 卡此前连一个按钮都没有 */}
            {action.type === 'errorOnly' && (
              <FailureActions
                busy={failureBusy}
                onContinue={failureTaskId === undefined || lastUserPrompt.trim() === ''
                  ? undefined
                  : () => void runFailureAction('continue', lastUserPrompt)}
                onRegenerate={lastUserPrompt.trim() === '' ? undefined : () => void runFailureAction('regenerate', lastUserPrompt)}
                onAbandon={() => setFailureDismissed(true)}
              />
            )}

            {/* 动作三态（DEF-248）：卡上写的只是"已申请"，做完没有要看任务上的回填台账 */}
            {action.type !== 'errorOnly' && (
              <ActionStateRow requestId={action.requestId} declared={declaredResult} />
            )}
          </div>
          )
        ) : <></>
      }
    </>

  )
}

export default ActionCard
