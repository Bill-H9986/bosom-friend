/**
 * DraftContentModule - 内容管理核心模块
 * 可复用的草稿管理区域，包含 AI生成栏、草稿列表、相关弹框
 */

'use client'

import type { DraftListSectionTab } from '../DraftListSection'
import { AlertTriangle, Loader2, Rocket } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@web/app/i18n/client'
import { useRouter } from '@web/next-shims/navigation'
import { Button } from '@web/components/ui/button'
import { AccountStatus } from '@web/app/config/accountConfig'
import { PubType } from '@web/app/config/publishConfig'
import { buildPublishParamsFromDraft } from '@web/components/PublishDialog/PublishDialog.util'
import { usePublishDialog } from '@web/components/PublishDialog/usePublishDialog'
import { useAccountStore } from '@web/store/account'
import { usePlanDetailStore } from '@web/store/draft-box/planDetailStore'
import { openPublishDialog } from '@web/store/publishDialogHost'
import { usePlatformMetadataStore } from '@web/store/platformMetadata'
import { getPlatformInfoSync } from '@web/store/platformMetadata'
import { isPlatformAvailable } from '@web/store/platformMetadata/utils'
import { useUserStore } from '@web/store/user'
import { appendAgentFeedback, captureCurrentPage } from '@web/utils/agentFeedback'
import { useGenerationPolling } from '../../hooks/useGenerationPolling'
import AiBatchGenerateBar from '../AiBatchGenerateBar'
import { useMediaTabStore } from '../ContentTabs/mediaTabStore'
import { CreateMaterialModal } from '../CreateMaterialModal'
import { DraftDetailDialog } from '../DraftDetailDialog'
import { DraftListSection } from '../DraftListSection'
import { GenerationDetailDialog } from '../GenerationDetailDialog'
import { TransferDraftDialog } from '../TransferDraftDialog'
import { VideoCreateDraftTaskWidget } from '../VideoCreateDraftTaskWidget'

interface DraftContentModuleProps {
  /** 外部指定草稿箱 ID，不依赖当前草稿箱 */
  groupId?: string
  /** 草稿列表可见 Tab */
  draftListTabs?: DraftListSectionTab[]
  /** 草稿列表默认 Tab */
  draftListDefaultTab?: DraftListSectionTab
  /** 是否强制使用草稿生成模式 */
  forceDraftMode?: boolean
  /** 是否允许转移草稿 */
  allowTransfer?: boolean
  /** 是否显示视频生成草稿长任务悬浮窗 */
  showVideoCreateDraftTaskWidget?: boolean
  /** 内容区域外层样式 */
  contentClassName?: string
  /** 是否嵌入到其他弹框/面板中 */
  embedded?: boolean
  /** 是否允许拖拽草稿/素材到发布弹框 */
  enablePublishDrag?: boolean
}

function DraftContentModule({
  groupId,
  draftListTabs,
  draftListDefaultTab,
  forceDraftMode = false,
  allowTransfer = true,
  showVideoCreateDraftTaskWidget = true,
  contentClassName = 'space-y-6 p-4 md:p-6',
  embedded = false,
  enablePublishDrag = false,
}: DraftContentModuleProps) {
  const { t } = useTransClient('brandPromotion')
  const router = useRouter()
  const problemAccountCount = useAccountStore(
    state => state.accountList.filter(account => account.status !== AccountStatus.USABLE).length,
  )

  // 一键发布：直接打开发布弹框（不关联具体草稿），默认选中全部可用账号
  const openDirectPublish = useCallback(() => {
    usePlanDetailStore.getState().openPublishDialog(null)
  }, [])

  const goAccounts = useCallback(() => {
    router.push('/accounts')
  }, [router])

  const {
    currentPlan,
    createMaterialModalOpen,
    editingMaterial,
    generationTasks,
    publishDialogOpen,
    publishingDraft,
    publishAutoMode,
    closeMaterialModal,
    fetchMaterials,
    closePublishDialog,
    syncGenerationTasks,
    updateGeneratingCount,
  } = usePlanDetailStore(
    useShallow(state => ({
      currentPlan: state.currentPlan,
      createMaterialModalOpen: state.createMaterialModalOpen,
      editingMaterial: state.editingMaterial,
      generationTasks: state.generationTasks,
      publishDialogOpen: state.publishDialogOpen,
      publishingDraft: state.publishingDraft,
      publishAutoMode: state.publishAutoMode,
      closeMaterialModal: state.closeMaterialModal,
      fetchMaterials: state.fetchMaterials,
      closePublishDialog: state.closePublishDialog,
      syncGenerationTasks: state.syncGenerationTasks,
      updateGeneratingCount: state.updateGeneratingCount,
    })),
  )

  const selectedPlanId = groupId || currentPlan?.id || null
  const previousMediaResetPlanIdRef = useRef<string | null>(null)
  const pollingTaskIds = useMemo(
    () => generationTasks.filter(task => task.status === 'generating').map(task => task.id),
    [generationTasks],
  )

  const accountList = useAccountStore(state => state.accountList)
  const platformMetadataStatus = usePlatformMetadataStore(state => state.status)
  const publishAutoModeRef = useRef(publishAutoMode)
  const autoModeAtOpenRef = useRef(false)
  useEffect(() => {
    publishAutoModeRef.current = publishAutoMode
  }, [publishAutoMode])
  useEffect(() => {
    if (publishDialogOpen && publishAutoMode)
      autoModeAtOpenRef.current = true
  }, [publishDialogOpen, publishAutoMode])

  // Plan 切换时重置媒体 Tab 数据
  useLayoutEffect(() => {
    const previousPlanId = previousMediaResetPlanIdRef.current

    if (!selectedPlanId) {
      return
    }

    if (previousPlanId === selectedPlanId) {
      return
    }

    previousMediaResetPlanIdRef.current = selectedPlanId
    useMediaTabStore.getState().reset(selectedPlanId)
  }, [selectedPlanId])

  // AI 批量生成轮询
  useGenerationPolling({
    enabled: pollingTaskIds.length > 0,
    taskIds: pollingTaskIds,
    interval: 2000,
    onTasksUpdate: syncGenerationTasks,
    onTaskCompleted: () => {
      if (selectedPlanId) {
        // silentRefreshAll 内部已同步草稿数据到 planDetailStore，无需单独调用 silentRefreshMaterials
        useMediaTabStore.getState().silentRefresh(selectedPlanId)
        useMediaTabStore.getState().silentRefreshAll(selectedPlanId, selectedPlanId)
      }
      useUserStore.getState().fetchCreditsBalance()
    },
    onCountUpdate: updateGeneratingCount,
  })

  // 根据草稿类型计算默认选中的账户
  const defaultAccountIds = useMemo(() => {
    if (!publishingDraft) {
      return undefined
    }
    const isVideo = publishingDraft.mediaList?.some(m => m.type === 'video')
    const targetPubType = isVideo ? PubType.VIDEO : PubType.ImageText
    const targetPlatform = (publishingDraft as { platform?: string }).platform

    const ids = accountList
      .filter((acc) => {
        if (targetPlatform && acc.type !== targetPlatform)
          return false
        const platConfig = getPlatformInfoSync(acc.type)
        return isPlatformAvailable(platConfig) && platConfig.pubTypes.has(targetPubType) && acc.status !== 0
      })
      .map(acc => acc.id)
    return ids
  }, [publishingDraft, accountList])

  // 发布弹框打开后预填草稿数据
  useEffect(() => {
    if (!publishDialogOpen || !publishingDraft)
      return

    const timer = setTimeout(async () => {
      const store = usePublishDialog.getState()
      // 草稿预填不再依赖账号选中：标题/正文/话题/图片写入公共参数区，
      // 账号可在之后单选/多选，选中后各账号参数会再同步这份草稿内容。
      store.setPrefillLoading(true)
      try {
        store.setAccountAllParams(await buildPublishParamsFromDraft(publishingDraft))
      }
      finally {
        store.setPrefillLoading(false)
      }
    }, 500)

    return () => {
      clearTimeout(timer)
      usePublishDialog.getState().setPrefillLoading(false)
    }
  }, [publishDialogOpen, publishingDraft, accountList, platformMetadataStatus])

  // 创建草稿成功回调
  const handleMaterialSuccess = useCallback(() => {
    if (selectedPlanId) {
      fetchMaterials(selectedPlanId, 1)
    }
    useUserStore.getState().fetchCreditsBalance()
  }, [fetchMaterials, selectedPlanId])

  const handlePublishSuccess = useCallback(() => {
    const shouldAutoSync = autoModeAtOpenRef.current
    usePlanDetailStore.getState().closePublishDialog()
    if (shouldAutoSync) {
      window.location.hash = '#/data-statistics'
    }
    void (async () => {
      try {
        const dataUrl = await captureCurrentPage()
        await appendAgentFeedback('AI 智能体已完成发布流程，以下为发布完成后的页面截图。', dataUrl)
      }
      catch {
        await appendAgentFeedback('AI 智能体已完成发布流程，请前往数据中心查看平台同步结果。')
      }
    })()
  }, [router])

  // 发布弹窗由布局壳统一挂载：本模块只把「打开了 + 参数」交给宿主，不再自带一份实例。
  const publishHostOpenRef = useRef(false)
  useEffect(() => {
    if (embedded)
      return
    if (publishDialogOpen && !publishHostOpenRef.current) {
      publishHostOpenRef.current = true
      openPublishDialog({
        accounts: accountList,
        defaultAccountIds,
        onPubSuccess: handlePublishSuccess,
        autoPublishOnReady: publishAutoMode,
        onClosed: () => {
          publishHostOpenRef.current = false
          usePlanDetailStore.getState().closePublishDialog()
        },
      })
      return
    }
    if (!publishDialogOpen)
      publishHostOpenRef.current = false
  }, [embedded, publishDialogOpen, accountList, defaultAccountIds, handlePublishSuccess, publishAutoMode])

  return (
    <>
      <div className={embedded ? '@container' : undefined}>
        <div className={embedded ? 'flex flex-col gap-4 p-4' : contentClassName}>
          {/* AI 批量生成输入栏 */}
          <AiBatchGenerateBar groupId={selectedPlanId || undefined} forceDraftMode={forceDraftMode} />
          {/* 内容 Tabs：草稿箱 / 视频 / 图片 */}
          {selectedPlanId
            ? (
                <DraftListSection
                  materialGroupId={selectedPlanId}
                  tabs={draftListTabs}
                  defaultTab={draftListDefaultTab}
                  allowTransfer={allowTransfer}
                  batchActionPosition={embedded ? 'sticky' : 'fixed'}
                  useContainerResponsive={embedded}
                  enablePublishDrag={enablePublishDrag}
                />
              )
            : (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              )}
        </div>
      </div>

      {/* 创建草稿弹窗 */}
      <CreateMaterialModal
        open={createMaterialModalOpen}
        groupId={selectedPlanId}
        editingMaterial={editingMaterial}
        onClose={closeMaterialModal}
        onSuccess={handleMaterialSuccess}
      />

      {/* 草稿详情弹窗 */}
      <DraftDetailDialog allowTransfer={allowTransfer} />

      {/* 移动到草稿箱弹窗 */}
      {allowTransfer && <TransferDraftDialog />}

      {/* 生成任务详情弹框 */}
      <GenerationDetailDialog />

      {/* 视频生成草稿长任务悬浮窗 */}
      {showVideoCreateDraftTaskWidget && <VideoCreateDraftTaskWidget />}
    </>
  )
}

export default DraftContentModule
