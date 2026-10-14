/**
 * 草稿详情弹框组件
 * 展示草稿的完整信息，支持编辑和删除操作
 * PC端左右布局：左侧媒体资源，右侧信息
 */

'use client'

import type { PromotionMaterial } from '@web/api/materials/material.types'
import type { PlatType } from '@web/app/config/platConfig'
import { ArrowRightLeft, Calendar, Edit, Image as ImageIcon, Loader2, Send, ShieldCheck, Trash2, Video } from 'lucide-react'
import NextImage from '@web/next-shims/image'
import { memo, useCallback, useEffect, useState } from 'react'
import { Navigation, Pagination } from 'swiper/modules'
import { Swiper, SwiperSlide } from 'swiper/react'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@web/app/i18n/client'
import { OssImage } from '@web/components/common/OssImage'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog'
import { Badge } from '@web/components/ui/badge'
import { Button } from '@web/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@web/components/ui/dialog'
import { ScrollArea } from '@web/components/ui/scroll-area'
import { usePlanDetailStore } from '@web/store/draft-box/planDetailStore'
import { useTransferDraftDialogStore } from '@web/store/draft-box/transferDraftDialogStore'
import { getPlatformInfoSync } from '@web/store/platformMetadata'
import { cn } from '@web/utils/className'
import { formatDate } from '@web/utils/format'
import { getOssThumbnailUrl } from '@web/utils/oss'
import { toast } from '@web/utils/ui/toast'
import { setAgentFocus } from '@web/utils/agentFocus'
import http from '@web/utils/request'
import { getMaterialUseCountLabels } from '../utils/materialUseCount'
import styles from './DraftDetailDialog.module.scss'
import { GenerationParamsCard } from './GenerationParamsCard'
import { LazyImage } from './LazyImage'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'

// 带 loading 状态的图片组件
function MediaImage({ src, alt }: { src: string, alt: string }) {
  const [loaded, setLoaded] = useState(false)

  return (
    <div className="relative flex items-center justify-center w-full h-full">
      {/* Loading 骨架 - 增强效果 */}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/80">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted-foreground/30 border-t-primary" />
        </div>
      )}
      <OssImage
        src={src}
        alt={alt}
        width={800}
        height={600}
        className={cn(
          'max-w-full max-h-full object-contain transition-opacity duration-300',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
        onLoad={() => setLoaded(true)}
        sizes="(max-width: 768px) 100vw, 60vw"
        unoptimized
      />
    </div>
  )
}

// 媒体预览组件 - 使用 Swiper 轮播
const MediaPreview = memo(({ material }: { material: PromotionMaterial }) => {
  const mediaList = material.mediaList || []
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isHovered, setIsHovered] = useState(false)

  // 检查是否全是图片（非视频）
  const isAllImages = mediaList.length > 0 && !mediaList.some(m => m.type === 'video')

  // 无媒体但有封面
  if (mediaList.length === 0 && material.coverUrl) {
    return (
      <div className="relative w-full h-full rounded-lg overflow-hidden bg-muted">
        <LazyImage
          src={material.coverUrl}
          alt={material.title || '草稿封面'}
          fill
          className="object-cover"
          skeletonClassName="rounded-lg"
          sizes="(max-width: 768px) 100vw, 60vw"
          useOssThumbnail
        />
      </div>
    )
  }

  // 无媒体无封面
  if (mediaList.length === 0) {
    return (
      <div className="flex items-center justify-center w-full h-full rounded-lg bg-muted">
        <ImageIcon className="h-12 w-12 text-muted-foreground" />
      </div>
    )
  }

  // 有媒体 - 使用 Swiper
  return (
    <div
      className={cn(
        'w-full h-full min-h-[300px] rounded-lg overflow-hidden bg-muted relative',
        styles.draftMediaSwiper,
        isHovered ? styles.swiperVisible : styles.swiperHidden,
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Swiper
        data-testid="draftbox-detail-swiper"
        modules={[Navigation, Pagination]}
        navigation={mediaList.length > 1}
        pagination={{ clickable: true }}
        loop={mediaList.length > 1}
        observer={true}
        observeParents={true}
        onSlideChange={swiper => setCurrentIndex(swiper.realIndex)}
        className="h-full w-full"
      >
        {mediaList.map((media, index) => (
          <SwiperSlide key={index} className="!flex items-center justify-center">
            {media.type === 'video'
              ? (
                  <video
                    src={media.url}
                    controls
                    autoPlay
                    loop
                    playsInline
                    className="w-full h-full object-contain bg-white"
                    poster={material.coverUrl ? getOssThumbnailUrl(material.coverUrl, { width: 960, quality: 75 }) : undefined}
                  />
                )
              : (
                  <MediaImage
                    src={media.url}
                    alt={material.title || `媒体 ${index + 1}`}
                  />
                )}
          </SwiperSlide>
        ))}
      </Swiper>

      {/* 右上角页码指示器 - 仅图片且多于1张时显示 */}
      {isAllImages && mediaList.length > 1 && (
        <div className={cn(
          'absolute top-3 right-3 z-10 px-2.5 py-1 rounded-full text-xs font-medium',
          'bg-black/50 text-white backdrop-blur-sm',
          'transition-opacity duration-200',
          isHovered ? 'opacity-100' : 'opacity-0',
        )}
        >
          {currentIndex + 1}
          {' '}
          /
          {mediaList.length}
        </div>
      )}
    </div>
  )
})

MediaPreview.displayName = 'MediaPreview'

// 详情弹框内容组件
interface DraftDetailContentProps {
  allowTransfer?: boolean
}

const DraftDetailContent = memo(({ allowTransfer = true }: DraftDetailContentProps) => {
  const { t } = useTransClient('brandPromotion')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  const {
    selectedDraft,
    isSubmitting,
    openEditMaterialModal,
    closeDraftDetailDialog,
    deleteMaterial,
    openPublishDialog,
  } = usePlanDetailStore(
    useShallow(state => ({
      selectedDraft: state.selectedDraft,
      isSubmitting: state.isSubmitting,
      openEditMaterialModal: state.openEditMaterialModal,
      closeDraftDetailDialog: state.closeDraftDetailDialog,
      deleteMaterial: state.deleteMaterial,
      openPublishDialog: state.openPublishDialog,
    })),
  )

  const openTransferDialog = useTransferDraftDialogStore(state => state.openDialog)

  // 打开哪条草稿就把哪条登记成助手的焦点：用户在弹窗里问"这条怎么改"，
  // 助手读到的是这条草稿的标题与描述，不需要用户复述（ADR-004 S1）。
  useEffect(() => {
    if (!selectedDraft)
      return
    setAgentFocus({
      page: '内容创作',
      objectKind: '草稿',
      objectId: selectedDraft.id,
      title: selectedDraft.title ?? '',
      excerpt: (selectedDraft.desc ?? '').slice(0, 600),
    })
    return () => setAgentFocus(null)
  }, [selectedDraft])

  // ---- 对象级 AI 动作（ADR-004 S2）--------------------------------------------------
  // 与"把内容复制进对话框再让助手改"的区别：这里点一次，结果**写回这条草稿本身**，
  // 用户不需要搬运数据。动作清单由服务端给（actions 接口），界面不写死有哪些动作。
  const [objectActions, setObjectActions] = useState<Array<{ id: string, label: string }>>([])
  const [runningAction, setRunningAction] = useState('')

  useEffect(() => {
    let alive = true
    void http.get<{ list: Array<{ id: string, label: string }> }>('ai/object-actions', { kind: 'draft' })
      // 泛型是**载荷**类型，返回值是信封：动作清单在 `res.data.list`，不是 `res.list`。
      .then((res) => { if (alive) setObjectActions(res?.data?.list ?? []) })
      // 拿不到动作清单时不显示按钮（而不是显示一排点了没反应的按钮）。
      .catch(() => { if (alive) setObjectActions([]) })
    return () => { alive = false }
  }, [])

  const runObjectAction = useCallback(async (actionId: string) => {
    if (!selectedDraft || runningAction !== '')
      return
    setRunningAction(actionId)
    try {
      // 请求层对业务失败**不抛错**：原样返回信封 `{code, data, message}` 并已弹过全局提示。
      // 必须自己判 code、自己取 data.data——把返回值当成 data 本身，成功也会走失败分支。
      // value 可能是字符串，也可能是话题这类字符串列表——两者的归宿都是"写回那个字段"。
      const envelope = await http.post<{ field?: string, value?: string | string[] }>('ai/object-action', {
        kind: 'draft',
        id: selectedDraft.id,
        action: actionId,
      })
      if (envelope?.code !== 0) return
      const written = envelope.data
      if (!written?.field) {
        toast.error('AI 没有返回可用内容，请重试')
        return
      }
      // 写回的是同一条对象：先更新正在看的这一条，再让列表重新拉一次，两个面板不会各说各话。
      usePlanDetailStore.setState({
        selectedDraft: { ...selectedDraft, [written.field]: written.value } as typeof selectedDraft,
      })
      // 让列表重新拉一次，两个面板不会各说各话。这里不用 store 里的 refreshCurrentMaterials 包一层：
      // 那个方法没有出现在 store 的对外类型上（combine 的类型只覆盖 state 切片），
      // 而同样的三行在 store 内部是能通过类型检查的写法。
      const store = usePlanDetailStore.getState()
      if (store.currentPlan)
        await store.fetchMaterials(store.currentPlan.id, 1)
      toast.success('已更新这一条')
    }
    catch (error) {
      toast.error(error instanceof Error ? error.message : 'AI 动作失败，请重试')
    }
    finally {
      setRunningAction('')
    }
  }, [selectedDraft, runningAction])

  // 处理编辑
  const handleEdit = useCallback(() => {
    if (selectedDraft) {
      closeDraftDetailDialog()
      openEditMaterialModal(selectedDraft)
    }
  }, [selectedDraft, closeDraftDetailDialog, openEditMaterialModal])

  // 处理发布
  const handlePublish = useCallback(() => {
    if (selectedDraft) {
      closeDraftDetailDialog()
      openPublishDialog(selectedDraft)
    }
  }, [selectedDraft, closeDraftDetailDialog, openPublishDialog])

  const handleTransfer = useCallback(() => {
    if (!selectedDraft) {
      return
    }

    closeDraftDetailDialog()
    openTransferDialog({
      currentPlanId: selectedDraft.groupId,
      draftIds: [selectedDraft.id],
      mediaIds: [],
    })
  }, [closeDraftDetailDialog, openTransferDialog, selectedDraft])

  // 处理删除
  const handleDelete = useCallback(async () => {
    if (!selectedDraft)
      return

    const success = await deleteMaterial(selectedDraft.id)
    if (success) {
      toast.success(t('plan.deleteSuccess'))
      closeDraftDetailDialog()
    }
    else {
      toast.error(t('plan.deleteFailed'))
    }
    setDeleteConfirmOpen(false)
  }, [selectedDraft, deleteMaterial, closeDraftDetailDialog, t])

  if (!selectedDraft)
    return null

  return (
    <>
      {/* 无障碍：隐藏的标题 */}
      <DialogTitle className="sr-only">{t('draft.detailTitle')}</DialogTitle>

      {/* PC端左右布局，移动端垂直布局 */}
      <div className="flex flex-col md:flex-row md:gap-6 md:h-[80vh]">
        {/* 左侧：媒体区域 */}
        <div className="md:w-3/5 flex-shrink-0 h-[40vh] md:h-full">
          <MediaPreview material={selectedDraft} />
        </div>

        {/* 右侧：信息区域 - 移动端限制最大高度使 ScrollArea 生效 */}
        <div className="md:w-2/5 mt-4 md:mt-0 flex flex-col max-h-[35vh] md:max-h-none md:h-full">
          {/* 可滚动内容 */}
          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-4 pr-2">
              {/* 标题 */}
              <div>
                <h3 className="text-lg font-medium">
                  {selectedDraft.title || t('material.untitled')}
                </h3>
              </div>

              {/* 描述 */}
              {selectedDraft.desc && (
                <div>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {selectedDraft.desc}
                  </p>
                </div>
              )}

              {/* 对象级 AI 动作：点一次，结果写回这条草稿 */}
              {objectActions.length > 0 && (
                <div className="flex flex-wrap gap-2" data-testid="draft-ai-actions">
                  {objectActions.map(action => (
                    <Button
                      key={action.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={runningAction !== ''}
                      onClick={() => void runObjectAction(action.id)}
                    >
                      {runningAction === action.id
                        ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />处理中…</>
                        : action.label}
                    </Button>
                  ))}
                </div>
              )}

              {/* 话题 */}
              {selectedDraft.topics && selectedDraft.topics.length > 0 && (
                <div className="flex flex-wrap gap-x-2 gap-y-1">
                  {selectedDraft.topics.map((topic, index) => (
                    <span key={index} className="text-sm text-primary">
                      #
                      {topic}
                    </span>
                  ))}
                </div>
              )}

              {/* AI 合规检查结论：不改内容、只给判断，单独一块显示（发布前就该看得见） */}
              {selectedDraft.aiCompliance && (
                <div className="rounded-lg border border-border/60 bg-muted/40 px-2.5 py-2">
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <ShieldCheck className="size-3.5 text-primary" />
                    合规检查
                  </p>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                    {selectedDraft.aiCompliance}
                  </p>
                </div>
              )}

              {/* AI 配图建议：与合规检查同类（不改内容、只给判断），单独一块 */}
              {selectedDraft.aiIllustration && (
                <div className="rounded-lg border border-border/60 bg-muted/40 px-2.5 py-2">
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <ImageIcon className="size-3.5 text-primary" />
                    配图建议
                  </p>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                    {selectedDraft.aiIllustration}
                  </p>
                </div>
              )}

              {/* AI 生成参数 */}
              {selectedDraft.generationParams && (
                <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
                  <GenerationParamsCard
                    params={selectedDraft.generationParams}
                    t={t}
                    showPlatforms={false}
                    applyTargetGroupId={selectedDraft.groupId}
                    onApplied={closeDraftDetailDialog}
                  />
                </div>
              )}

              {/* 统计信息 */}
              <div className="flex flex-wrap items-center gap-2">
                {getMaterialUseCountLabels(selectedDraft, t, { showZeroTotal: true }).map(label => (
                  <Badge key={label} variant="secondary">
                    {label}
                  </Badge>
                ))}
                {selectedDraft.mediaList && selectedDraft.mediaList.length > 0 && (
                  <Badge variant="outline">
                    {selectedDraft.mediaList.some(m => m.type === 'video')
                      ? (
                          <>
                            <Video className="h-3 w-3 mr-1" />
                            {t('planType.video')}
                          </>
                        )
                      : (
                          <>
                            <ImageIcon className="h-3 w-3 mr-1" />
                            {t('planType.article')}
                            {selectedDraft.mediaList.length > 1 && (
                              <span className="ml-1">
                                (
                                {selectedDraft.mediaList.length}
                                )
                              </span>
                            )}
                          </>
                        )}
                  </Badge>
                )}
              </div>

              {/* 平台图标 */}
              {selectedDraft.accountTypes && selectedDraft.accountTypes.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {selectedDraft.accountTypes.map((type) => {
                    const platInfo = getPlatformInfoSync(type as PlatType)
                    if (!platInfo)
                      return null
                    return (
                      <NextImage
                        key={type}
                        src={platInfo.icon}
                        alt={platInfo.name}
                        width={20}
                        height={20}
                        className="w-5 h-5"
                        unoptimized
                      />
                    )
                  })}
                </div>
              )}

              {/* 创建时间 */}
              {selectedDraft.createdAt && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  <span>
                    {t('draft.createdAt')}
                    :
                    {' '}
                    {formatDate(selectedDraft.createdAt)}
                  </span>
                </div>
              )}
            </div>
          </ScrollArea>

          {/* 固定底部的操作按钮 */}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4 flex-shrink-0">
            <Button
              data-testid="draftbox-detail-edit-btn"
              variant="outline"
              className="min-w-[calc(50%-0.25rem)] flex-1 cursor-pointer md:min-w-0"
              onClick={handleEdit}
            >
              <Edit className="h-4 w-4 mr-2" />
              {t('draft.edit')}
            </Button>
            {allowTransfer && (
              <Button
                variant="outline"
                className="min-w-[calc(50%-0.25rem)] flex-1 cursor-pointer md:min-w-0"
                onClick={handleTransfer}
              >
                <ArrowRightLeft className="h-4 w-4 mr-2" />
                {t('draftManage.transfer')}
              </Button>
            )}
            <Button
              data-testid="draftbox-detail-publish-btn"
              className="min-w-[calc(50%-0.25rem)] flex-1 cursor-pointer md:min-w-0"
              onClick={handlePublish}
            >
              <Send className="h-4 w-4 mr-2" />
              {t('draft.publish')}
            </Button>
            <Button
              data-testid="draftbox-detail-delete-btn"
              variant="outline"
              className="min-w-[calc(50%-0.25rem)] flex-1 cursor-pointer text-destructive hover:text-destructive md:min-w-0"
              onClick={() => setDeleteConfirmOpen(true)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {t('draft.delete')}
            </Button>
          </div>
        </div>
      </div>

      {/* 删除确认弹窗 */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('plan.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('plan.deleteConfirmDesc', { name: selectedDraft.title || t('material.untitled') })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">{t('common.cancel')}</AlertDialogCancel>
            <Button
              className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={isSubmitting}
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t('common.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
})

DraftDetailContent.displayName = 'DraftDetailContent'

// 主组件
interface DraftDetailDialogProps {
  allowTransfer?: boolean
}

export const DraftDetailDialog = memo(({ allowTransfer = true }: DraftDetailDialogProps) => {
  const { draftDetailDialogOpen } = usePlanDetailStore(
    useShallow(state => ({
      draftDetailDialogOpen: state.draftDetailDialogOpen,
    })),
  )

  const closeDraftDetailDialog = usePlanDetailStore(state => state.closeDraftDetailDialog)

  // 根据疑难杂症记录 #2，拆成两层组件避免闪烁
  if (!draftDetailDialogOpen)
    return null

  return (
    <Dialog open onOpenChange={closeDraftDetailDialog}>
      <DialogContent data-testid="draftbox-detail-dialog" className="sm:max-w-md md:max-w-6xl">
        <DraftDetailContent allowTransfer={allowTransfer} />
      </DialogContent>
    </Dialog>
  )
})

DraftDetailDialog.displayName = 'DraftDetailDialog'
