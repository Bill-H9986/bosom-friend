/**
 * ContentListSection - 内容瀑布流列表区域
 * 瀑布流布局 + IntersectionObserver 无限滚动，支持批量选择、转移与删除
 *
 * 两种数据源：
 * - all：全部页签，草稿 + 视频 + 图片三路合并且按创建时间倒序，批量删除为混合删除
 * - video/img：视频、图片页签，单一素材类型，批量删除按类型删除
 */

'use client'

import type { MediaItem, PromotionMaterial } from '@web/api/materials/material.types'
import type { MediaPreviewItem } from '@web/components/common/MediaPreview'
import { ArrowRightLeft, ImageIcon, Inbox, Loader2, Trash2, Video } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import Masonry from 'react-masonry-css'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@web/app/i18n/client'
import { MediaPreview } from '@web/components/common/MediaPreview'
import { Button } from '@web/components/ui/button'
import { Checkbox } from '@web/components/ui/checkbox'
import { usePlanDetailStore } from '@web/store/draft-box/planDetailStore'
import { useTransferDraftDialogStore } from '@web/store/draft-box/transferDraftDialogStore'
import { cn } from '@web/utils/className'
import { getOssUrl } from '@web/utils/oss'
import { confirm } from '@web/utils/ui/confirm'
import { toast } from '@web/utils/ui/toast'
import { useContainerMasonryColumns } from '../../hooks/useContainerMasonryColumns'
import { useDeleteGenerationTask } from '../../hooks/useDeleteGenerationTask'
import { useDraftReferenceMaxImages } from '../../hooks/useDraftReferenceMaxImages'
import { useMediaTabStore } from '../ContentTabs/mediaTabStore'
import { DraftCard } from '../DraftCard'
import { GeneratingTaskCard, getDraftGenerationTaskTarget, shouldShowDraftGenerationTaskCard } from '../GeneratingCard'
import { ListCardSkeleton } from '../ListCardSkeleton'
import { ListLoadingIndicator } from '../ListLoadingIndicator'
import { LOAD_MORE_OBSERVER_OPTIONS } from '../loadMoreObserver'
import { MASONRY_BREAKPOINTS } from '../masonryBreakpoints'
import { MediaAddToReferenceAction } from '../MediaAddToReferenceAction'
import { MediaCard } from '../MediaCard'
import { VideoCreateDraftAction } from '../VideoCreateDraftAction'

/** 列表数据源：全部（草稿 + 视频 + 图片）或单一素材类型 */
export type ContentListSourceType = 'all' | 'video' | 'img'

interface ContentListSectionProps {
  sourceType: ContentListSourceType
  materialGroupId: string
  showBatchDeleteTrigger?: boolean
  batchActionPosition?: 'fixed' | 'sticky'
  useContainerResponsive?: boolean
  enablePublishDrag?: boolean
}

/** 列表渲染项，草稿与媒体共用同一瀑布流 */
type ContentListItem =
  | { key: string; kind: 'draft'; material: PromotionMaterial }
  | { key: string; kind: 'media'; media: MediaItem }

/** 媒体数据转预览弹窗条目 */
function toMediaPreviewItem(media: MediaItem): MediaPreviewItem {
  return {
    type: media.type === 'video' ? 'video' : 'image',
    src: getOssUrl(media.url),
    title: media.title,
  }
}

export const ContentListSection = memo(({
  sourceType,
  materialGroupId,
  showBatchDeleteTrigger = true,
  batchActionPosition = 'fixed',
  useContainerResponsive = false,
  enablePublishDrag = false,
}: ContentListSectionProps) => {
  const { t } = useTransClient('material')
  const { t: tBrand } = useTransClient('brandPromotion')
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const draftReferenceMaxImages = useDraftReferenceMaxImages(materialGroupId)
  const { containerRef, masonryColumns } = useContainerMasonryColumns(useContainerResponsive)
  const masonryBreakpointCols = useContainerResponsive ? masonryColumns : MASONRY_BREAKPOINTS
  const handleDeleteGeneration = useDeleteGenerationTask()

  const isAllSource = sourceType === 'all'
  // 单一类型数据源的媒体类型；全部数据源下不参与取数
  const mediaType: 'video' | 'img' = sourceType === 'img' ? 'img' : 'video'

  const { mergedList, allLoading, allInitialized, allExhausted } = useMediaTabStore(
    useShallow(state => ({
      mergedList: state.all.mergedList,
      allLoading: state.all.loading,
      allInitialized: state.all.initialized,
      allExhausted: state.all.allExhausted,
    })),
  )

  const { typeList, typeLoading, typeHasMore, typeInitialized } = useMediaTabStore(
    useShallow(state => ({
      typeList: state[mediaType].list,
      typeLoading: state[mediaType].loading,
      typeHasMore: state[mediaType].hasMore,
      typeInitialized: state[mediaType].initialized,
    })),
  )

  const { batchMode, selectedItems, batchDeleting } = useMediaTabStore(
    useShallow(state => ({
      batchMode: state.batchMode,
      selectedItems: state.selectedItems,
      batchDeleting: state.batchDeleting,
    })),
  )

  const { previewOpen, previewIndex, previewType } = useMediaTabStore(
    useShallow(state => ({
      previewOpen: state.previewOpen,
      previewIndex: state.previewIndex,
      previewType: state.previewType,
    })),
  )

  const fetchAllList = useMediaTabStore(state => state.fetchAllList)
  const loadMoreAll = useMediaTabStore(state => state.loadMoreAll)
  const fetchMediaList = useMediaTabStore(state => state.fetchMediaList)
  const loadMoreMedia = useMediaTabStore(state => state.loadMore)
  const enterBatchMode = useMediaTabStore(state => state.enterBatchMode)
  const exitBatchMode = useMediaTabStore(state => state.exitBatchMode)
  const toggleSelection = useMediaTabStore(state => state.toggleSelection)
  const selectAllLoaded = useMediaTabStore(state => state.selectAllLoaded)
  const deselectAll = useMediaTabStore(state => state.deselectAll)
  const batchDeleteAll = useMediaTabStore(state => state.batchDeleteAll)
  const batchDeleteByType = useMediaTabStore(state => state.batchDeleteByType)
  const openPreview = useMediaTabStore(state => state.openPreview)
  const closePreview = useMediaTabStore(state => state.closePreview)

  const generationTasks = usePlanDetailStore(state => state.generationTasks)
  const openDraftDetailDialog = usePlanDetailStore(state => state.openDraftDetailDialog)
  const openGenerationDetailDialog = usePlanDetailStore(state => state.openGenerationDetailDialog)
  const openTransferDialog = useTransferDraftDialogStore(state => state.openDialog)

  const itemCount = isAllSource ? mergedList.length : typeList.length
  const loading = isAllSource ? allLoading : typeLoading
  const initialized = isAllSource ? allInitialized : typeInitialized
  const hasMore = isAllSource ? !allExhausted : typeHasMore

  const selectedIds = useMemo(() => {
    if (isAllSource)
      return Object.keys(selectedItems)

    return Object.entries(selectedItems)
      .filter(([, source]) => source === mediaType)
      .map(([id]) => id)
  }, [isAllSource, mediaType, selectedItems])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectedCount = selectedIds.length
  const allSelected = itemCount > 0 && selectedCount === itemCount

  const visibleGenerationTasks = useMemo(() => {
    const visibleTasks = generationTasks.filter(shouldShowDraftGenerationTaskCard)
    if (isAllSource)
      return visibleTasks

    return visibleTasks.filter(task => getDraftGenerationTaskTarget(task) === mediaType)
  }, [generationTasks, isAllSource, mediaType])
  const showGenerationTasks = !batchMode && visibleGenerationTasks.length > 0

  const items = useMemo((): ContentListItem[] => {
    if (isAllSource) {
      return mergedList.map((item): ContentListItem => item.source === 'draft'
        ? { key: `draft-${item.id}`, kind: 'draft', material: item.data as PromotionMaterial }
        : { key: `${item.source}-${item.id}`, kind: 'media', media: item.data as MediaItem })
    }

    return typeList.map((media): ContentListItem => ({ key: media._id, kind: 'media', media }))
  }, [isAllSource, mergedList, typeList])

  // 首次加载
  useEffect(() => {
    if (initialized || !materialGroupId)
      return

    if (isAllSource)
      fetchAllList(materialGroupId, materialGroupId)
    else
      fetchMediaList(materialGroupId, mediaType)
  }, [initialized, materialGroupId, isAllSource, mediaType, fetchAllList, fetchMediaList])

  // IntersectionObserver 无限滚动
  useEffect(() => {
    const loadMoreElement = loadMoreRef.current
    if (!loadMoreElement)
      return

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries
        if (!entry.isIntersecting || !hasMore || loading || !materialGroupId)
          return

        if (isAllSource)
          loadMoreAll(materialGroupId, materialGroupId)
        else
          loadMoreMedia(materialGroupId, mediaType)
      },
      LOAD_MORE_OBSERVER_OPTIONS,
    )

    observer.observe(loadMoreElement)
    return () => observer.disconnect()
  }, [hasMore, loading, materialGroupId, isAllSource, mediaType, loadMoreAll, loadMoreMedia])

  // 媒体卡片点击 - 打开预览
  const handleMediaClick = useCallback((media: MediaItem) => {
    if (isAllSource) {
      // 找到在合并列表中同类型媒体的索引（用于预览导航）
      const mediaItems = mergedList.filter(item => item.source === media.type)
      const index = mediaItems.findIndex(item => item.id === media._id)
      if (index !== -1)
        openPreview(media.type, index)
      return
    }

    const index = typeList.findIndex(item => item._id === media._id)
    if (index !== -1)
      openPreview(mediaType, index)
  }, [isAllSource, mergedList, typeList, mediaType, openPreview])

  // 全选/取消全选
  const handleToggleSelectAll = useCallback(() => {
    if (allSelected)
      deselectAll()
    else
      selectAllLoaded(isAllSource ? 'all' : mediaType)
  }, [allSelected, deselectAll, isAllSource, mediaType, selectAllLoaded])

  // 批量删除
  const handleBatchDelete = useCallback(() => {
    if (selectedCount === 0)
      return

    confirm({
      title: t('mediaManagement.batchDeleteConfirmTitle'),
      content: t('mediaManagement.batchDeleteConfirmDesc', { count: selectedCount }),
      okType: 'destructive',
      onOk: async () => {
        const result = isAllSource
          ? await batchDeleteAll(materialGroupId, materialGroupId)
          : await batchDeleteByType(materialGroupId, mediaType)
        if (!result.ok) {
          toast.error(t('mediaManagement.batchDeleteFailed'))
          return
        }
        // 被生成记录引用的素材服务端会保留：按实际结果提示，避免报「移除成功」但卡片刷新后仍在。
        if (result.kept > 0) {
          toast.warning(`已移除 ${result.deleted} 项；${result.kept} 项仍被生成记录引用，未移除`)
          return
        }
        toast.success(t('mediaManagement.batchDeleteSuccess'))
      },
    })
  }, [batchDeleteAll, batchDeleteByType, isAllSource, materialGroupId, mediaType, selectedCount, t])

  const handleTransfer = useCallback(() => {
    if (selectedCount === 0)
      return

    const draftIds: string[] = []
    const mediaIds: string[] = []

    Object.entries(selectedItems).forEach(([id, source]) => {
      if (source === 'draft') {
        draftIds.push(id)
      }
      else {
        mediaIds.push(id)
      }
    })

    openTransferDialog({
      currentPlanId: materialGroupId,
      draftIds,
      mediaIds,
    })
  }, [materialGroupId, openTransferDialog, selectedCount, selectedItems])

  // 预览项列表（全部列表按当前预览类型过滤）
  const previewItems = useMemo((): MediaPreviewItem[] => {
    if (isAllSource) {
      return mergedList
        .filter(item => item.source === previewType)
        .map(item => toMediaPreviewItem(item.data as MediaItem))
    }

    return typeList.map(toMediaPreviewItem)
  }, [isAllSource, mergedList, typeList, previewType])
  const showPreview = isAllSource || previewType === mediaType

  // 初始加载骨架屏
  if (loading && itemCount === 0) {
    return (
      <div ref={useContainerResponsive ? containerRef : undefined}>
        <Masonry
          breakpointCols={masonryBreakpointCols}
          className="flex -ml-4 w-auto"
          columnClassName="pl-4 bg-clip-padding"
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <ListCardSkeleton key={i} index={i} />
          ))}
        </Masonry>
      </div>
    )
  }

  // 空状态
  if (initialized && itemCount === 0 && (isAllSource ? !showGenerationTasks : visibleGenerationTasks.length === 0)) {
    const Icon = isAllSource ? Inbox : (mediaType === 'video' ? Video : ImageIcon)
    return (
      <div className="flex min-h-[calc(100vh-260px)] flex-col items-center justify-center py-12">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <Icon className="w-8 h-8 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground mb-1">
          {isAllSource
            ? t('mediaManagement.noMedia')
            : (mediaType === 'video' ? t('mediaManagement.noVideo') : t('mediaManagement.noImage'))}
        </p>
        <p className="text-sm text-muted-foreground">
          {isAllSource
            ? t('mediaManagement.noMediaDesc')
            : (mediaType === 'video' ? t('mediaManagement.noVideoDesc') : t('mediaManagement.noImageDesc'))}
        </p>
      </div>
    )
  }

  return (
    <div ref={useContainerResponsive ? containerRef : undefined}>
      {/* 工具栏 */}
      {batchMode
        ? (
            <div className={cn('mb-4 flex items-center gap-3', useContainerResponsive && 'flex-wrap @min-[640px]:flex-nowrap')}>
              <div className="flex items-center gap-2 cursor-pointer" onClick={handleToggleSelectAll}>
                <Checkbox checked={allSelected} onCheckedChange={handleToggleSelectAll} />
                <span className="text-sm">{t('mediaManagement.selectAll')}</span>
              </div>
              <span className="text-sm text-muted-foreground">
                {t('mediaManagement.selectedCount', { count: selectedCount })}
              </span>
              <div className={useContainerResponsive ? 'flex-[1_1_100%] @min-[640px]:flex-1' : 'flex-1'} />
              <Button
                variant="outline"
                size="sm"
                onClick={handleTransfer}
                disabled={selectedCount === 0 || batchDeleting}
                className="cursor-pointer gap-1.5"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
                {tBrand('draftManage.transfer')}
              </Button>
              <Button variant="ghost" size="sm" onClick={exitBatchMode} className="cursor-pointer">
                {t('mediaManagement.cancel')}
              </Button>
            </div>
          )
        : (
            showBatchDeleteTrigger
              ? (
                  <div className={cn('mb-4 flex items-center gap-3', useContainerResponsive && 'flex-wrap @min-[640px]:flex-nowrap')}>
                    <div className={useContainerResponsive ? 'flex-[1_1_100%] @min-[640px]:flex-1' : 'flex-1'} />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={enterBatchMode}
                      className="cursor-pointer gap-1.5"
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5" />
                      {tBrand('draftManage.batchTransfer')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={enterBatchMode}
                      className="cursor-pointer gap-1.5"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('mediaManagement.batchDelete')}
                    </Button>
                  </div>
                )
              : null
          )}

      <Masonry
        breakpointCols={masonryBreakpointCols}
        className="flex -ml-4 w-auto"
        columnClassName="pl-4 bg-clip-padding"
      >
        {!batchMode && visibleGenerationTasks.map(task => (
          <GeneratingTaskCard key={task.id} task={task} onClick={openGenerationDetailDialog} onDelete={handleDeleteGeneration} />
        ))}
        {items.map(item => item.kind === 'draft'
          ? (
              <DraftCard
                key={item.key}
                variant="compact"
                material={item.material}
                onClick={() => openDraftDetailDialog(item.material)}
                batchMode={batchMode}
                selected={selectedSet.has(item.material.id)}
                onToggleSelect={() => toggleSelection(item.material.id, 'draft')}
                enablePublishDrag={enablePublishDrag}
              />
            )
          : (
              <MediaCard
                key={item.key}
                media={item.media}
                onClick={handleMediaClick}
                useOssThumbnail={isAllSource || undefined}
                batchMode={batchMode}
                selected={selectedSet.has(item.media._id)}
                onToggleSelect={() => toggleSelection(item.media._id, isAllSource ? item.media.type : mediaType)}
                enablePublishDrag={enablePublishDrag}
                actions={
                  item.media.type === 'video'
                    ? <VideoCreateDraftAction media={item.media} groupId={materialGroupId} />
                    : <MediaAddToReferenceAction media={item.media} groupId={materialGroupId} maxImages={draftReferenceMaxImages} />
                }
              />
            ))}
      </Masonry>

      {/* 加载触发器 */}
      <div ref={loadMoreRef} />

      {/* 加载更多指示器 */}
      {loading && <ListLoadingIndicator label={isAllSource ? tBrand('common.loading') : undefined} />}

      {/* 没有更多数据 */}
      {!hasMore && itemCount > 0 && (
        <div className="flex items-center justify-center py-4">
          <span className="text-sm text-muted-foreground">
            {t('mediaManagement.loadedAll')}
          </span>
        </div>
      )}

      {/* 批量模式底部操作栏 */}
      {batchMode && (
        <div
          className={cn(
            'bottom-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-6 py-3',
            batchActionPosition === 'fixed' ? 'fixed left-0 right-0' : 'sticky -mx-4 sm:-mx-6',
          )}
        >
          <div className={useContainerResponsive ? 'mx-auto flex max-w-screen-2xl flex-col gap-3 @min-[640px]:flex-row @min-[640px]:items-center @min-[640px]:justify-between' : 'flex items-center justify-between max-w-screen-2xl mx-auto'}>
            <span className="text-sm text-muted-foreground">
              {t('mediaManagement.selectedCount', { count: selectedCount })}
            </span>
            <div className={useContainerResponsive ? 'flex flex-wrap items-center gap-2' : 'flex items-center gap-2'}>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTransfer}
                disabled={selectedCount === 0 || batchDeleting}
                className="cursor-pointer gap-1.5"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
                {tBrand('draftManage.transfer')}
              </Button>
              <Button variant="ghost" size="sm" onClick={exitBatchMode} className="cursor-pointer">
                {t('mediaManagement.cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBatchDelete}
                disabled={selectedCount === 0 || batchDeleting}
                className="cursor-pointer gap-1.5"
              >
                {batchDeleting
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Trash2 className="h-3.5 w-3.5" />}
                {t('mediaManagement.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 媒体预览弹窗 */}
      {showPreview && (
        <MediaPreview
          open={previewOpen}
          items={previewItems}
          initialIndex={previewIndex}
          onClose={closePreview}
        />
      )}
    </div>
  )
})

ContentListSection.displayName = 'ContentListSection'
