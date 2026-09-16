/**
 * 发布操作 Hook
 * 处理发布内容的核心逻辑
 */

import type { ChannelPublishUserActionVo } from '@web/api/channels/channel.types'
import type { PubItem } from '@web/components/PublishDialog/publishDialog.type'
import type {
  PlatformPublishMode,
  PlatformPublishTask,
  PluginPlatformType,
  PublishParams as PluginPublishParams,
  UnifiedPublishParams,
} from '@web/store/plugin'
import { useCallback } from 'react'
import { appendAgentFeedback, captureCurrentPage } from '@web/utils/agentFeedback'
import { createChannelPublishFlowApi, getChannelPublishUserActionApi } from '@web/api/channels/channel.api'
import { getPublishRecordDetailById } from '@web/api/platforms/publish.api'
import { PublishStatus } from '@web/api/platforms/publish.constants'
import {
  getDays,
  getUtcDays,
} from '@web/app/[lng]/accounts/components/CalendarTiming/calendarTiming.utils'
import { useCalendarTiming } from '@web/app/[lng]/accounts/components/CalendarTiming/useCalendarTiming'
import { AccountStatus } from '@web/app/config/accountConfig'
import { PlatType } from '@web/app/config/platConfig'
import {
  buildChannelPublishFlowParams,
  getPublishRecordIdFromFlow,
  isPublishTitleSupported,
} from '@web/components/PublishDialog/PublishDialog.util'
import { usePublishDialogStorageStore } from '@web/components/PublishDialog/usePublishDialogStorageStore'
import { usePlanDetailStore } from '@web/store/draft-box/planDetailStore'
import { getPlatformInfoSync, isPlatformDisabledSync, isPlatformEnabledSync } from '@web/store/platformMetadata'
import { PlatformTaskStatus, PLUGIN_SUPPORTED_PLATFORMS, usePluginStore } from '@web/store/plugin'
import { sleep } from '@web/utils/common'
import { toast } from '@web/utils/ui/toast'

const DOUYIN_RECORD_POLL_INTERVAL_MS = 5000
const DOUYIN_RECORD_POLL_MAX_COUNT = 36
const douyinRecordPollingStatuses: readonly number[] = [
  PublishStatus.UNPUBLISH,
  PublishStatus.PUB_LOADING,
  PublishStatus.QUEUED,
]
const douyinRecordFailedStatuses: readonly number[] = [
  PublishStatus.FAIL,
  PublishStatus.UPDATED_FAILED,
  PublishStatus.CANCELED,
]

function isDesktopEnv() {
  return typeof window !== 'undefined' && !!(window as any).ipcRenderer && !(window as any).ipcRenderer.__zyShim
}

/**
 * 发布成功后回读平台真实数据：
 * - 30 秒节流 + 尾部补发：节流窗口内的多次发布不丢失，窗口结束后补一次同步；
 * - 失败可重试：首次失败延迟 15 秒再补一次，仍失败给出可见提示（不打断发布主流程）。
 */
let lastPostPublishSyncAt = 0
let trailingPostPublishTimer: ReturnType<typeof setTimeout> | null = null
function triggerPostPublishSync() {
  if (!isDesktopEnv())
    return
  const now = Date.now()
  const doSync = () => {
    void (window as any).ipcRenderer.invoke('ICP_PUBLISH_SYNC_RECORDS').catch(() => {
      setTimeout(() => {
        void (window as any).ipcRenderer.invoke('ICP_PUBLISH_SYNC_RECORDS').catch(() => {
          toast.warning('发布成功，但数据回读暂未完成，稍后可在数据概览查看')
        })
      }, 15000)
    })
  }
  if (now - lastPostPublishSyncAt >= 30 * 1000) {
    lastPostPublishSyncAt = now
    doSync()
  }
  else {
    // 节流窗口内的发布不丢失：窗口结束后补发一次尾部同步
    if (trailingPostPublishTimer)
      clearTimeout(trailingPostPublishTimer)
    const remain = 30 * 1000 - (now - lastPostPublishSyncAt)
    trailingPostPublishTimer = setTimeout(() => {
      trailingPostPublishTimer = null
      lastPostPublishSyncAt = Date.now()
      doSync()
    }, remain + 100)
  }
}

function getMediaUrl(url?: string, ossUrl?: string): string {
  return ossUrl || url || ''
}

interface UsePublishActionsParams {
  pubListChoosed: PubItem[]
  pubTime?: string
  suppressAutoPublish?: boolean
  taskIdForPublish?: string
  materialGroupIdForPublish?: string
  materialIdForPublish?: string
  onPublishConfirmed?: (taskId?: string, publishRecordId?: string) => void
  onPublishStart?: () => void
  onClose: () => void
  onPubSuccess?: () => void
  setCreateLoading: (loading: boolean) => void
  setCurrentPublishTaskId: (taskId: string | undefined) => void
  setPublishDetailVisible: (visible: boolean) => void
  t: (key: string, params?: Record<string, string>) => string
}

/**
 * 检查平台是否由插件支持
 */
export function isPluginSupportedPlatform(platType: PlatType | string): boolean {
  return PLUGIN_SUPPORTED_PLATFORMS.includes(platType as PluginPlatformType)
}

function getPlatformTaskId(item: PubItem, publishMode: PlatformPublishMode) {
  return `${publishMode}-${item.account.type}-${item.account.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function buildTaskPublishParams(item: PubItem): UnifiedPublishParams {
  const params: UnifiedPublishParams = {
    platform: item.account.type as PlatType,
    accountId: item.account.id,
    type: item.params.video ? 'video' : 'image',
    desc: item.params.des || '',
    topics: item.params.topics || [],
  }

  if (isPublishTitleSupported(item.account.type))
    params.title = item.params.title || ''

  return params
}

function buildUnifiedPlatformTask(item: PubItem, publishMode: PlatformPublishMode): PlatformPublishTask {
  return {
    id: getPlatformTaskId(item, publishMode),
    platform: item.account.type as PlatType,
    accountId: item.account.id,
    publishMode,
    params: buildTaskPublishParams(item),
    status: PlatformTaskStatus.PENDING,
    progress: null,
    result: null,
    startTime: null,
    endTime: null,
    error: null,
  }
}

function hasDouyinUserAction(
  data: ChannelPublishUserActionVo | null | undefined,
): data is ChannelPublishUserActionVo & { schemeUrl: string, shortLink: string } {
  return !!data?.schemeUrl && !!data.shortLink
}

function normalizePublishStatus(status: string | number | undefined) {
  const normalized = Number(status)
  return Number.isFinite(normalized) ? normalized : undefined
}

function isDouyinUserActionReadyStatus(status: string | number | undefined) {
  return normalizePublishStatus(status) === PublishStatus.WAITING_FOR_USER_ACTION
}

function shouldPollDouyinRecord(status: string | number | undefined) {
  const normalized = normalizePublishStatus(status)
  return normalized !== undefined && douyinRecordPollingStatuses.includes(normalized)
}

function isDouyinRecordFailedStatus(status: string | number | undefined) {
  const normalized = normalizePublishStatus(status)
  return normalized !== undefined && douyinRecordFailedStatuses.includes(normalized)
}

async function pollDouyinRecordUntilUserActionReady(publishRecordId: string) {
  let latestRes: Awaited<ReturnType<typeof getPublishRecordDetailById>> | null = null

  for (let pollIndex = 0; pollIndex < DOUYIN_RECORD_POLL_MAX_COUNT; pollIndex++) {
    if (pollIndex > 0)
      await sleep(DOUYIN_RECORD_POLL_INTERVAL_MS)

    latestRes = await getPublishRecordDetailById(publishRecordId)
    const record = latestRes?.data
    if (!record)
      continue

    if (isDouyinUserActionReadyStatus(record.status))
      return latestRes

    if (isDouyinRecordFailedStatus(record.status) || !shouldPollDouyinRecord(record.status))
      return latestRes
  }

  return latestRes
}

/** 发布成功后让“数据中心”自动选中对应账号并回读平台数据（Web 与桌面通用）。 */
function requestPostPublishSync(accountId?: string): void {
  if (!accountId)
    return
  usePlanDetailStore.getState().setPendingAutoSync(accountId)
}

/**
 * 等待平台真实发布完成：只有记录状态为 {@link PublishStatus.RELEASED} 且携带平台作品 ID/链接才算成功；
 * 失败（{@link PublishStatus.FAIL}）或超时均返回失败原因。杜绝“创建任务就显示发布成功”。
 */
async function waitForRealPublish(publishRecordId: string): Promise<{ ok: boolean, workId?: string, error?: string }> {
  for (let pollIndex = 0; pollIndex < 72; pollIndex++) {
    if (pollIndex > 0)
      await sleep(5000)
    try {
      const res = await getPublishRecordDetailById(publishRecordId)
      const rec = res?.data
      if (!rec)
        continue
      const status = Number(rec.status)
      const workId = rec.platformWorkId || rec.workLink || ''
      if (status === PublishStatus.RELEASED && workId !== '')
        return { ok: true, workId }
      if (status === PublishStatus.FAIL)
        return { ok: false, error: rec.errorMsg || '平台发布失败' }
    }
    catch {
      // 网络抖动继续轮询
    }
  }
  return { ok: false, error: '发布超时（6 分钟），请检查账号状态后重试' }
}

/**
 * 发布操作 Hook
 */
export function usePublishActions({
  pubListChoosed,
  pubTime,
  suppressAutoPublish,
  taskIdForPublish,
  materialGroupIdForPublish,
  materialIdForPublish,
  onPublishConfirmed,
  onPublishStart,
  onClose,
  onPubSuccess,
  setCreateLoading,
  setCurrentPublishTaskId,
  setPublishDetailVisible,
  t,
}: UsePublishActionsParams) {
  /**
   * 执行发布
   * 1. API 发布与插件发布共用一个详情任务
   * 2. 插件发布立即启动，不等待 API 发布
   * 3. API 发布后台执行，只更新自己的平台任务状态
   */
  const pubClick = useCallback(async () => {
    const offlineItem = pubListChoosed.find(item => item.account.status === AccountStatus.DISABLE)
    if (offlineItem) {
      toast.error(t('tips.accountOffline'))
      return
    }

    const disabledItem = pubListChoosed.find(item => isPlatformDisabledSync(item.account.type))
    if (disabledItem) {
      toast.error(
        t('tips.platformComingSoon', {
          platform: getPlatformInfoSync(disabledItem.account.type)?.name || disabledItem.account.type,
        }),
      )
      return
    }

    const restrictedItem = pubListChoosed.find(item => !isPlatformEnabledSync(item.account.type))
    if (restrictedItem) {
      toast.error(
        t('tips.regionRestricted', {
          platform: getPlatformInfoSync(restrictedItem.account.type)?.name || restrictedItem.account.type,
        }),
      )
      return
    }

    setCreateLoading(true)
    onPublishStart?.()
    // AC-017 每步截图：提交发布这一步也留证（截图+说明入会话，可连续回看）
    void (async () => {
      try {
        const dataUrl = await captureCurrentPage()
        await appendAgentFeedback('AI 智能体已提交发布，正在等待平台返回真实作品 ID/链接。', dataUrl)
      }
      catch {
        await appendAgentFeedback('AI 智能体已提交发布，正在等待平台结果。')
      }
    })()

    const publishTime = getUtcDays(pubTime || getDays().add(5, 'second')).format()

    // 分离发布任务和自动发布列表：
    // 小红书/抖音为个人账号直连，走桌面直连（内核 CDP 页面驱动），不再归入官方插件
    const desktopKernelPlatforms = ['xhs', 'douyin']
    const apiPublishItems = pubListChoosed.filter(
      item =>
        desktopKernelPlatforms.includes(item.account.type)
        || !isPluginSupportedPlatform(item.account.type),
    )
    const pluginPublishItems = pubListChoosed.filter(item =>
      !desktopKernelPlatforms.includes(item.account.type)
      && isPluginSupportedPlatform(item.account.type),
    )

    // 桌面端本地账号（个人账号直连）：走桌面直连发布，不依赖后端渠道账号体系
    const desktopPublishable = isDesktopEnv()
      && apiPublishItems.length > 0
      && apiPublishItems.every(item => !!((item.account as { loginCookie?: string }).loginCookie))

    const pluginPlatformTasks: PlatformPublishTask[] = []
    const apiPlatformTaskMap = new Map<string, PlatformPublishTask>()
    const platformTaskIdMap = new Map<string, string>()

    pluginPublishItems.forEach((item) => {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      platformTaskIdMap.set(item.account.id, requestId)

      const pluginPublishParams: PluginPublishParams = {
        platform: item.account.type as PluginPlatformType,
        type: item.params.video ? 'video' : 'image',
        desc: item.params.des || '',
        topics: item.params.topics || [],
      }
      if (isPublishTitleSupported(item.account.type))
        pluginPublishParams.title = item.params.title || ''

      pluginPlatformTasks.push({
        ...buildUnifiedPlatformTask(item, 'auto'),
        requestId,
        params: pluginPublishParams,
      })
    })

    apiPublishItems.forEach((item) => {
      const publishMode: PlatformPublishMode = item.account.type === PlatType.Douyin ? 'user_action' : 'task'
      apiPlatformTaskMap.set(item.account.id, {
        ...buildUnifiedPlatformTask(item, publishMode),
        status: PlatformTaskStatus.PUBLISHING,
        startTime: Date.now(),
      })
    })

    const { addPublishTask, updatePlatformTask } = usePluginStore.getState()
    const taskTitle = pubListChoosed[0]?.params.title
      || pubListChoosed[0]?.params.des?.slice(0, 20)
      || t('title')
    const taskDescription = pubListChoosed[0]?.params.des?.slice(0, 100)
    const platformTasks = [
      ...pluginPlatformTasks,
      ...Array.from(apiPlatformTaskMap.values()),
    ]

    if (platformTasks.length === 0) {
      setCreateLoading(false)
      return
    }

    const taskId = addPublishTask({
      title: taskTitle,
      description: taskDescription,
      platformTasks,
    })

    setCurrentPublishTaskId(taskId)
    setPublishDetailVisible(true)
    onClose()

    const updateApiTask = (item: PubItem, updates: Partial<PlatformPublishTask>) => {
      const platformTask = apiPlatformTaskMap.get(item.account.id)
      if (!platformTask)
        return

      updatePlatformTask(taskId, platformTask.id, updates)
    }

    const updateDouyinUserActionError = (item: PubItem, publishRecordId: string, message?: string) => {
      const errorMessage = message || t('messages.userActionFetchFailed')
      updateApiTask(item, {
        status: PlatformTaskStatus.ERROR,
        publishRecordId,
        error: errorMessage,
        endTime: Date.now(),
        result: {
          success: false,
          failReason: errorMessage,
        },
      })
    }

    const fetchAndUpdateDouyinUserAction = async (item: PubItem, publishRecordId: string) => {
      try {
        const recordRes = await pollDouyinRecordUntilUserActionReady(publishRecordId)
        const record = recordRes?.data
        if (!record || !isDouyinUserActionReadyStatus(record.status)) {
          updateDouyinUserActionError(item, publishRecordId, record?.errorMsg || recordRes?.message)
          return
        }

        await useCalendarTiming.getState().refreshPubRecordDetail(publishRecordId)

        const userActionRes = await getChannelPublishUserActionApi(publishRecordId)
        if (userActionRes?.code !== 0 || !hasDouyinUserAction(userActionRes.data)) {
          updateDouyinUserActionError(item, publishRecordId, userActionRes?.message)
          return
        }

        const userActionPublishRecordId = userActionRes.data.recordId || publishRecordId
        updateApiTask(item, {
          status: PlatformTaskStatus.PENDING,
          publishRecordId: userActionPublishRecordId,
          userAction: {
            schemeUrl: userActionRes.data.schemeUrl,
            shortLink: userActionRes.data.shortLink,
            expiresAt: userActionRes.data.expiresAt,
          },
          progress: null,
          result: null,
          endTime: Date.now(),
        })
      }
      catch {
        updateDouyinUserActionError(item, publishRecordId)
      }
    }

    let firstPublishRecordId: string | undefined
    const hasPluginItems = pluginPublishItems.length > 0

    // 插件平台发布（官方扩展引擎）：桌面直连与常规流程共用，避免混合选择时插件平台任务被静默丢弃
    const executePluginPublishIfNeeded = () => {
      if (!hasPluginItems)
        return
      void usePluginStore.getState().executePluginPublish({
        items: pluginPublishItems,
        platformTaskIdMap,
        publishTime,
        userTaskId: taskIdForPublish, // 传递任务ID用于关联发布记录
        ...(materialGroupIdForPublish ? { materialGroupId: materialGroupIdForPublish } : {}),
        ...(materialIdForPublish ? { materialId: materialIdForPublish } : {}),
        skipAddTask: true,
        onComplete: (pluginPublishRecordId) => {
          useCalendarTiming.getState().getPubRecord()
          // 发布成功后立即回读平台真实数据，闭环「创作→发布→数据回读」
          triggerPostPublishSync()
          requestPostPublishSync(pluginPublishItems[0]?.account.id)
          if (suppressAutoPublish && onPublishConfirmed) {
            try {
              onPublishConfirmed(taskIdForPublish, pluginPublishRecordId || firstPublishRecordId)
            }
            catch (e) {
              console.error('发布确认回调失败', e)
            }
          }
        },
      })
    }

    if (desktopPublishable) {
      const desktopPayload = {
        items: apiPublishItems.map((item) => {
          const params = item.params
          const isVideo = !!params.video
          const mediaUrls = isVideo
            ? [getMediaUrl(params.video!.videoUrl, params.video!.ossUrl)].filter(Boolean)
            : (params.images || []).map(img => getMediaUrl(img.imgUrl, img.ossUrl)).filter(Boolean)
          const coverUrl = isVideo
            ? getMediaUrl(params.video!.cover?.imgUrl, params.video!.cover?.ossUrl)
              || (params.images?.[0] ? getMediaUrl(params.images[0].imgUrl, params.images[0].ossUrl) : '')
            : undefined

          return {
            accountId: Number(item.account.id),
            type: isVideo ? 'video' : 'image',
            platform: item.account.type,
            mediaUrls,
            ...(coverUrl ? { coverUrl } : {}),
            title: params.title || '',
            desc: params.des || '',
            topics: params.topics || [],
          }
        }),
      }

      try {
        const results = await (window as any).ipcRenderer.invoke('ICP_PUBLISH_DESKTOP_FLOW', desktopPayload)
        apiPublishItems.forEach((item, index) => {
          const res = results?.[index]
          const success = res?.code === 1
          updateApiTask(item, {
            status: success ? PlatformTaskStatus.COMPLETED : PlatformTaskStatus.ERROR,
            publishRecordId: res?.dataId,
            result: success
              ? { success: true, workId: res.dataId }
              : { success: false, failReason: res?.msg || t('messages.publishFailed') },
            ...(success ? {} : { error: res?.msg || t('messages.publishFailed') }),
            endTime: Date.now(),
          })
          if (success) {
            firstPublishRecordId = res.dataId
          }
        })
        // 桌面直连发布成功后立即回读平台真实数据
        if (results?.some((res: { code?: number }) => res?.code === 1)) {
          triggerPostPublishSync()
          const firstSuccess = apiPublishItems.find((_, index) => results?.[index]?.code === 1)
          requestPostPublishSync(firstSuccess?.account.id)
        }
      }
      catch (e) {
        apiPublishItems.forEach(item => updateApiTask(item, {
          status: PlatformTaskStatus.ERROR,
          error: e instanceof Error ? e.message : String(e),
          endTime: Date.now(),
          result: { success: false, failReason: e instanceof Error ? e.message : String(e) },
        }))
      }

      // 桌面直连分支也要执行插件平台发布（混合选择时插件平台不能被静默丢弃）
      executePluginPublishIfNeeded()

      setCreateLoading(false)
      if (onPubSuccess) {
        onPubSuccess()
      }
      usePublishDialogStorageStore.getState().clearPubData()
      return
    }

    // 插件发布与 API 发布分线执行：插件发布不等待 API 发布任务创建结果
    executePluginPublishIfNeeded()

    const executeApiPublish = async () => {
      if (apiPublishItems.length === 0)
        return true

      const flowParams = buildChannelPublishFlowParams(apiPublishItems, {
        publishAt: publishTime,
        userTaskId: taskIdForPublish,
        materialGroupId: materialGroupIdForPublish,
        materialId: materialIdForPublish,
        source: 'web',
      })

      if (!flowParams) {
        apiPublishItems.forEach(item => updateApiTask(item, {
          status: PlatformTaskStatus.ERROR,
          error: t('messages.publishFailed'),
          endTime: Date.now(),
          result: {
            success: false,
            failReason: t('messages.publishFailed'),
          },
        }))
        return false
      }

      let res: Awaited<ReturnType<typeof createChannelPublishFlowApi>>
      try {
        res = await createChannelPublishFlowApi(flowParams)
      }
      catch {
        apiPublishItems.forEach(item => updateApiTask(item, {
          status: PlatformTaskStatus.ERROR,
          error: t('messages.publishFailed'),
          endTime: Date.now(),
          result: {
            success: false,
            failReason: t('messages.publishFailed'),
          },
        }))
        return false
      }

      if (res?.code !== 0) {
        apiPublishItems.forEach(item => updateApiTask(item, {
          status: PlatformTaskStatus.ERROR,
          error: res?.message || t('messages.publishFailed'),
          endTime: Date.now(),
          result: {
            success: false,
            failReason: res?.message || t('messages.publishFailed'),
          },
        }))
        return false
      }

      firstPublishRecordId = getPublishRecordIdFromFlow(res.data)

      for (const item of apiPublishItems) {
        const publishRecordId = getPublishRecordIdFromFlow(res.data, item.account.id)
        if (!publishRecordId) {
          updateApiTask(item, {
            status: PlatformTaskStatus.ERROR,
            error: t('messages.publishFailed'),
            endTime: Date.now(),
            result: {
              success: false,
              failReason: t('messages.publishFailed'),
            },
          })
          return false
        }

        // 真实发布校验：等到平台返回作品 ID/链接才算成功，失败/超时不跳“发布成功”。
        const outcome = await waitForRealPublish(publishRecordId)
        if (!outcome.ok) {
          updateApiTask(item, {
            status: PlatformTaskStatus.ERROR,
            publishRecordId,
            error: outcome.error,
            endTime: Date.now(),
            result: {
              success: false,
              failReason: outcome.error,
            },
          })
          return false
        }
        firstPublishRecordId = publishRecordId
        updateApiTask(item, {
          status: PlatformTaskStatus.COMPLETED,
          publishRecordId,
          progress: {
            stage: 'complete',
            progress: 100,
            message: t('messages.publishTaskCreated'),
            timestamp: Date.now(),
          },
          result: {
            success: true,
            workId: outcome.workId,
          },
          endTime: Date.now(),
        })
      }

      requestPostPublishSync(apiPublishItems[0]?.account.id)
      return true
    }

    const apiPublishPromise = executeApiPublish()
    if (!hasPluginItems) {
      const apiPublishSuccess = await apiPublishPromise
      if (!apiPublishSuccess) {
        setCreateLoading(false)
        return
      }
    }
    else {
      void apiPublishPromise
    }

    if (suppressAutoPublish) {
      if (!hasPluginItems && onPublishConfirmed) {
        try {
          onPublishConfirmed(taskIdForPublish, firstPublishRecordId)
        }
        catch (e) {
          console.error('发布确认回调失败', e)
        }
      }
    }

    setCreateLoading(false)
    if (onPubSuccess) {
      onPubSuccess()
    }
    usePublishDialogStorageStore.getState().clearPubData()
  }, [
    pubListChoosed,
    pubTime,
    suppressAutoPublish,
    taskIdForPublish,
    materialGroupIdForPublish,
    materialIdForPublish,
    onPublishConfirmed,
    onPublishStart,
    onClose,
    onPubSuccess,
    setCreateLoading,
    setCurrentPublishTaskId,
    setPublishDetailVisible,
    t,
  ])

  return {
    pubClick,
    isPluginSupportedPlatform,
  }
}
