/**
 * Agent Store - Action 处理器模块
 * 使用策略模式处理不同的任务结果操作
 *
 * 从 public/AgentGenerator/actionHandlers.ts 移植并增强
 */

import type { ActionType, IActionContext, IMediaItem, ITaskData } from '../agent.types'
import type { PluginPublishItem } from '@web/store/plugin/store'
import { driver } from 'driver.js'
import { executeAgentSaveDraftAction, executeAgentUpdateDraftAction } from '@web/components/Chat/ActionCard/executePublishAction'
import { useAccountStore } from '@web/store/account'
import { usePluginStore } from '@web/store/plugin'
import { PluginStatus } from '@web/store/plugin/types/baseTypes'
import { confirm } from '@web/utils/ui/confirm'
import { toast } from '@web/utils/ui/toast'
import { shouldUseDesktopPublish } from '@web/utils/publish/desktopRoute'
import { isDesktopEnv } from '@web/components/ChannelManager/utils/desktopLogin'

// ============ Action Handler 接口 ============

/** Action Handler 接口 */
export interface IActionHandler {
  /** Action 类型 */
  type: ActionType
  /** 判断是否能处理该任务 */
  canHandle: (taskData: ITaskData) => boolean
  /** 执行 Action */
  execute: (taskData: ITaskData, context: IActionContext) => Promise<void>
}

// ============ 工具函数 ============

/**
 * 构建发布 URL 参数
 */
function buildPublishQueryParams(taskData: ITaskData): URLSearchParams {
  const params = new URLSearchParams()

  params.set('action', 'publish')
  params.set('aiGenerated', 'true')

  // 只添加非空值
  if (taskData.platform)
    params.set('platform', taskData.platform)
  if (taskData.accountId)
    params.set('accountId', taskData.accountId)
  if (taskData.taskId)
    params.set('taskId', taskData.taskId)
  if (taskData.title)
    params.set('title', taskData.title)
  if (taskData.description)
    params.set('description', taskData.description)
  if (taskData.tags && taskData.tags.length > 0) {
    params.set('tags', JSON.stringify(taskData.tags))
  }
  if (taskData.medias && taskData.medias.length > 0) {
    params.set('medias', JSON.stringify(taskData.medias))
  }

  return params
}

/**
 * 构建插件发布项
 */
export function buildPluginPublishItem(taskData: ITaskData, account: any): PluginPublishItem {
  const medias = taskData.medias || []
  const hasVideo = medias.some((m: IMediaItem) => m.type === 'VIDEO')
  const video = hasVideo ? medias.find((m: IMediaItem) => m.type === 'VIDEO') : null

  const images = medias
    .filter((m: IMediaItem) => m.type === 'IMAGE')
    .map((m: IMediaItem) => ({
      id: '',
      imgPath: m.url,
      ossUrl: m.url,
      size: 0,
      imgUrl: m.url,
      filename: '',
      width: 0,
      height: 0,
    })) as any[]

  return {
    account,
    params: {
      title: taskData.title || '',
      des: taskData.description || '',
      topics: taskData.tags || [],
      video: video
        ? ({
            size: 0,
            videoUrl: video.url,
            ossUrl: video.url,
            filename: '',
            width: 0,
            height: 0,
            duration: 0,
            cover: {
              id: '',
              imgPath: video.coverUrl || video.thumbUrl || '',
              ossUrl: video.coverUrl || video.thumbUrl,
              size: 0,
              imgUrl: video.coverUrl || video.thumbUrl || '',
              filename: '',
              width: 0,
              height: 0,
            },
          } as any)
        : undefined,
      images: images.length > 0 ? images : undefined,
      option: {},
    },
  }
}

/**
 * 显示插件引导
 */
function showPluginGuide(t: (key: string) => string) {
  setTimeout(() => {
    const pluginButton = document.querySelector(
      '[data-driver-target="plugin-button"]',
    ) as HTMLElement
    if (!pluginButton) {
      console.warn('[ActionHandler] Plugin button not found')
      return
    }

    const driverObj = driver({
      showProgress: false,
      showButtons: ['next'],
      nextBtnText: t('aiGeneration.gotIt' as any),
      doneBtnText: t('aiGeneration.gotIt' as any),
      popoverOffset: 10,
      stagePadding: 4,
      stageRadius: 12,
      allowClose: true,
      smoothScroll: true,
      steps: [
        {
          element: '[data-driver-target="plugin-button"]',
          popover: {
            title: t('plugin.authorizePluginTitle' as any),
            description: t('plugin.authorizePluginDescription' as any),
            side: 'bottom',
            align: 'start',
            onPopoverRender: () => {
              setTimeout(() => {
                const nextBtn = document.querySelector(
                  '.driver-popover-next-btn',
                ) as HTMLButtonElement
                const doneBtn = document.querySelector(
                  '.driver-popover-done-btn',
                ) as HTMLButtonElement
                const btn = nextBtn || doneBtn
                if (btn) {
                  btn.textContent = t('aiGeneration.gotIt' as any)
                  const handleClick = (e: MouseEvent) => {
                    e.preventDefault()
                    e.stopPropagation()
                    driverObj.destroy()
                    btn.removeEventListener('click', handleClick)
                  }
                  btn.addEventListener('click', handleClick)
                }
              }, 50)
            },
          },
        },
      ],
      onNextClick: () => {
        driverObj.destroy()
        return false
      },
    })

    driverObj.drive()
  }, 1500)
}

// ============ Action Handlers 实现 ============

/**
 * 导航到发布页面 - 浏览器环境处理插件平台（xhs, douyin）
 */
const navigateToPublishPluginHandler: IActionHandler = {
  type: 'navigateToPublish',

  canHandle: (taskData) => {
    return (
      taskData.type === 'fullContent'
      && taskData.action === 'navigateToPublish'
      && (taskData.platform === 'xhs' || taskData.platform === 'douyin')
      && !shouldUseDesktopPublish(taskData.platform, isDesktopEnv())
    )
  },

  async execute(taskData, context) {
    const { t } = context
    const pluginStatus = usePluginStore.getState().status
    const isPluginReady = pluginStatus === PluginStatus.READY

    if (!isPluginReady) {
      toast.warning(t('plugin.platformNeedsPlugin' as any))
      showPluginGuide(t as (key: string) => string)
      return
    }

    // 插件已就绪，执行发布
    try {
      const accountGroupList = useAccountStore.getState().accountGroupList
      const allAccounts = accountGroupList.reduce<any[]>((acc, group) => {
        return [...acc, ...group.children]
      }, [])

      // 根据 accountId 或 platform 查找目标账号
      let targetAccounts: any[] = []
      if (taskData.accountId) {
        const targetAccount = allAccounts.find(account => account.id === taskData.accountId)
        if (targetAccount) {
          targetAccounts = [targetAccount]
        }
        else {
          console.warn(`[ActionHandler] Account not found: ${taskData.accountId}`)
        }
      }
      else {
        targetAccounts = allAccounts.filter(account => account.type === taskData.platform)
      }

      if (targetAccounts.length === 0) {
        console.warn(`[ActionHandler] No accounts found for platform: ${taskData.platform}`)
        toast.warning(t('aiGeneration.noAccountFound' as any) || '未找到可发布的账号')
        return
      }

      // 构建发布项
      const allPluginPublishItems: PluginPublishItem[] = []
      const platformTaskIdMap = new Map<string, string>()

      targetAccounts.forEach((account) => {
        const publishItem = buildPluginPublishItem(taskData, account)
        // @ts-ignore
        allPluginPublishItems.push(publishItem)

        const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        platformTaskIdMap.set(account.id, requestId)
      })

      if (allPluginPublishItems.length > 0) {
        usePluginStore.getState().executePluginPublish({
          items: allPluginPublishItems,
          platformTaskIdMap,
          onProgress: (event) => {
            const { stage, progress, message: progressMessage, accountId, platform } = event
            if (stage === 'error') {
              toast.error(progressMessage)
            }
          },
          onComplete: () => {
            toast.info(t('plugin.publishTaskSubmitted' as any))
          },
        })
      }
    }
    catch (error: any) {
      console.error('[ActionHandler] Plugin publish error:', error)
      toast.error(
        `${t('plugin.publishFailed' as any)}: ${error.message || t('aiGeneration.unknownError' as any)}`,
      )
    }
  },
}

/**
 * 导航到发布页面 - 处理其他平台（快手等）
 */
const navigateToPublishOtherHandler: IActionHandler = {
  type: 'navigateToPublish',

  canHandle: (taskData) => {
    return (
      taskData.type === 'fullContent'
      && taskData.action === 'navigateToPublish'
      && taskData.platform !== 'xhs'
      && taskData.platform !== 'douyin'
    )
  },

  async execute(taskData, context) {
    const { router, lng } = context
    const queryParams = buildPublishQueryParams(taskData)

    setTimeout(() => {
      router.push(`/accounts?${queryParams.toString()}`)
    }, 1500)
  },
}

/**
 * 导航到草稿箱
 */
const navigateToDraftHandler: IActionHandler = {
  type: 'navigateToDraft',

  canHandle: (taskData) => {
    return taskData.type === 'fullContent' && taskData.action === 'navigateToDraft'
  },

  async execute(_taskData, context) {
    const { router, lng } = context

    setTimeout(() => {
      // 2026-10-12 修：这里原本 push `/cgmaterial`——路由表里没有这条路由
      // （electron/src/router/index.tsx），点击会被通配兜底弹回首页；
      // 而这个动作的语义就是"跳到草稿/内容创作"，落点应是 /draft-box。
      router.push(`/draft-box`)
    }, 1500)
  },
}

/**
 * 保存草稿
 */
const saveDraftHandler: IActionHandler = {
  type: 'saveDraft',

  canHandle: (taskData) => {
    return taskData.type === 'fullContent' && taskData.action === 'saveDraft'
  },

  /**
   * 跟随模式下自动执行：走前端执行器把 AI 的内容写进草稿箱。
   * 内核不再写草稿文件（产品铁律 #2），这里调的是前端自己的草稿接口。
   */
  async execute(taskData) {
    const ok = await executeAgentSaveDraftAction({
      type: 'saveDraft',
      title: taskData.title,
      description: taskData.description,
      tags: taskData.tags,
    })
    if (ok) toast.success('已存进草稿箱')
    else toast.error('存草稿失败：内容为空或接口报错')
  },
}


/**
 * 改写草稿：跟随模式下由前端把新标题/正文写回那条草稿。
 */
const updateDraftHandler: IActionHandler = {
  type: 'updateDraft',

  canHandle: (taskData) => {
    return taskData.type === 'fullContent' && taskData.action === 'updateDraft'
  },

  async execute(taskData) {
    const extra = taskData as unknown as { draftId?: string }
    const ok = await executeAgentUpdateDraftAction({
      type: 'updateDraft',
      draftId: extra.draftId,
      title: taskData.title,
      description: taskData.description,
    })
    if (ok) toast.success('已写回草稿')
    else toast.error('改写失败：缺少草稿 id 或内容为空')
  },
}

/**
 * 更新频道授权
 */
const updateChannelHandler: IActionHandler = {
  type: 'updateChannel',

  canHandle: (taskData) => {
    return taskData.type === 'fullContent' && taskData.action === 'updateChannel'
  },

  async execute(taskData, context) {
    const { router, lng, t } = context
    const platform = taskData.platform

    toast.warning(t('aiGeneration.channelAuthExpired' as any))

    confirm({
      title: t('aiGeneration.channelAuthExpiredTitle' as any),
      content: t('aiGeneration.channelAuthExpiredContent' as any),
      okText: t('aiGeneration.reauthorize' as any),
      cancelText: t('aiGeneration.cancel' as any),
      onOk: () => {
        router.push(`/accounts?updateChannel=${platform}`)
      },
    })
  },
}

/**
 * 登录频道
 */
const loginChannelHandler: IActionHandler = {
  type: 'loginChannel',

  canHandle: (taskData) => {
    return taskData.type === 'fullContent' && taskData.action === 'loginChannel'
  },

  async execute(taskData, context) {
    const { router, lng, t } = context
    const platform = taskData.platform

    toast.info(t('aiGeneration.needLoginChannel' as any))

    confirm({
      title: t('aiGeneration.needLogin' as any),
      content: t('aiGeneration.pleaseLoginChannel' as any),
      okText: t('aiGeneration.goLogin' as any),
      cancelText: t('aiGeneration.cancel' as any),
      onOk: () => {
        router.push(`/accounts?loginChannel=${platform}`)
      },
    })
  },
}

/**
 * 创建频道（需要先绑定账号）
 */
const createChannelHandler: IActionHandler = {
  type: 'createChannel',

  canHandle: (taskData) => {
    return !!(taskData.type === 'fullContent' && taskData.action === 'createChannel')
  },

  async execute(taskData, context) {
    const { router, lng, t } = context
    const platform = taskData.platform
    const platformName = platform
      ? platform.charAt(0).toUpperCase() + platform.slice(1)
      : 'Platform'

    toast.warning(t('aiGeneration.needBindChannel' as any) as string)

    confirm({
      title: t('aiGeneration.needBindChannelTitle' as any) as string,
      content: t('aiGeneration.needBindChannelContent' as any, {
        platform: platformName,
      }) as string,
      okText: t('aiGeneration.goBind' as any) as string,
      cancelText: undefined, // 不显示取消按钮
      onOk: () => {
        router.push(`/accounts?addChannel=${platform}`)
      },
    })
  },
}

/**
 * 默认发布处理（无 action 时）
 */
const defaultPublishHandler: IActionHandler = {
  type: 'navigateToPublish',

  canHandle: (taskData) => {
    return taskData.type === 'fullContent' && !taskData.action
  },

  async execute(taskData, context) {
    const { router, lng } = context
    const queryParams = buildPublishQueryParams(taskData)

    setTimeout(() => {
      router.push(`/accounts?${queryParams.toString()}`)
    }, 1500)
  },
}

// ============ Action Registry ============

/** 所有注册的 Action Handlers */
const actionHandlers: IActionHandler[] = [
  navigateToPublishPluginHandler,
  navigateToPublishOtherHandler,
  navigateToDraftHandler,
  saveDraftHandler,
  updateDraftHandler,
  updateChannelHandler,
  loginChannelHandler,
  createChannelHandler,
  defaultPublishHandler,
]

/**
 * Action 注册表
 * 使用策略模式管理和执行不同的 Action
 */
export const ActionRegistry = {
  /**
   * 注册新的 Action Handler
   * @param handler Action Handler
   */
  register(handler: IActionHandler): void {
    // 添加到列表开头，确保新注册的优先匹配
    actionHandlers.unshift(handler)
  },

  /**
   * 执行 Action
   * @param taskData 任务数据
   * @param context Action 上下文
   * @returns 是否成功执行
   */
  async execute(taskData: ITaskData, context: IActionContext): Promise<boolean> {
    // 跳过纯媒体类型
    if (
      taskData.type === 'imageOnly'
      || taskData.type === 'videoOnly'
      || taskData.type === 'mediaOnly'
    ) {
      return false
    }

    // 查找匹配的 Handler
    const handler = actionHandlers.find(h => h.canHandle(taskData))

    if (handler) {
      await handler.execute(taskData, context)
      return true
    }

    console.warn('[ActionRegistry] No handler found for task:', taskData)
    return false
  },

  /**
   * 批量执行 Actions（处理多个任务结果）
   * @param taskDataList 任务数据列表
   * @param context Action 上下文
   */
  async executeBatch(taskDataList: ITaskData[], context: IActionContext): Promise<void> {
    // 分离插件平台任务和其他任务
    const pluginTasks: ITaskData[] = []
    const otherTasks: ITaskData[] = []

    taskDataList.forEach((taskData) => {
      // 跳过纯媒体类型
      if (
        taskData.type === 'imageOnly'
        || taskData.type === 'videoOnly'
        || taskData.type === 'mediaOnly'
      ) {
        return
      }

      if (taskData.type === 'fullContent' && taskData.action === 'navigateToPublish') {
        if (!shouldUseDesktopPublish(taskData.platform, isDesktopEnv())) {
          pluginTasks.push(taskData)
        }
        else {
          otherTasks.push(taskData)
        }
      }
      else {
        otherTasks.push(taskData)
      }
    })

    // 批量处理插件平台任务
    if (pluginTasks.length > 0) {
      await ActionRegistry.executePluginBatch(pluginTasks, context)
    }

    // 逐个处理其他任务
    for (const taskData of otherTasks) {
      await ActionRegistry.execute(taskData, context)
    }
  },

  /**
   * 批量执行插件平台发布
   * @param pluginTasks 插件平台任务列表
   * @param context Action 上下文
   */
  async executePluginBatch(pluginTasks: ITaskData[], context: IActionContext): Promise<void> {
    const pluginStatus = usePluginStore.getState().status
    const isPluginReady = pluginStatus === PluginStatus.READY
    const { t } = context

    if (!isPluginReady) {
      toast.warning(t('plugin.platformNeedsPlugin' as any))
      showPluginGuide(t as (key: string) => string)
      return
    }

    try {
      const accountGroupList = useAccountStore.getState().accountGroupList
      const allAccounts = accountGroupList.reduce<any[]>((acc, group) => {
        return [...acc, ...group.children]
      }, [])

      const allPluginPublishItems: PluginPublishItem[] = []
      const platformTaskIdMap = new Map<string, string>()

      pluginTasks.forEach((taskData) => {
        let targetAccounts: any[] = []
        if (taskData.accountId) {
          const targetAccount = allAccounts.find(account => account.id === taskData.accountId)
          if (targetAccount) {
            targetAccounts = [targetAccount]
          }
        }
        else {
          targetAccounts = allAccounts.filter(account => account.type === taskData.platform)
        }

        if (targetAccounts.length === 0) {
          console.warn(`[ActionRegistry] No accounts found for platform: ${taskData.platform}`)
          return
        }

        targetAccounts.forEach((account) => {
          const publishItem = buildPluginPublishItem(taskData, account)
          // @ts-ignore
          allPluginPublishItems.push(publishItem)

          const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
          platformTaskIdMap.set(account.id, requestId)
        })
      })

      if (allPluginPublishItems.length > 0) {
        usePluginStore.getState().executePluginPublish({
          items: allPluginPublishItems,
          platformTaskIdMap,
          onProgress: (event) => {
            const { stage, progress, message: progressMessage, accountId, platform } = event

            if (stage === 'error') {
              toast.error(progressMessage)
            }
          },
          onComplete: () => {
            toast.info(t('plugin.publishTaskSubmitted' as any))
          },
        })
      }
      else {
        toast.warning(t('aiGeneration.noAccountFound' as any) || '未找到可发布的账号')
      }
    }
    catch (error: any) {
      console.error('[ActionRegistry] Plugin batch publish error:', error)
      toast.error(
        `${t('plugin.publishFailed' as any)}: ${error.message || t('aiGeneration.unknownError' as any)}`,
      )
    }
  },

  /**
   * 获取所有已注册的 Action 类型
   */
  getRegisteredTypes(): ActionType[] {
    return [...new Set(actionHandlers.map(h => h.type))]
  },
}

export default ActionRegistry
