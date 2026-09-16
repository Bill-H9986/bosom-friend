/**
 * 生成任务详情弹框
 * 展示 AI 批量生成任务的列表，支持无限滚动加载
 */

'use client'

import type { DraftGenerationResponse, DraftGenerationTask } from '@web/api/ai/ai.types'
import { AlertCircle, AlertTriangle, CheckCircle2, Copy, Loader2, Play, Trash2 } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { apiGetDraftGenerationList } from '@web/api/ai/ai.api'
import { confirm } from '@web/utils/ui/confirm'
import { toast } from '@web/utils/ui/toast'
import { useTransClient } from '@web/app/i18n/client'
import { MediaPreview } from '@web/components/common/MediaPreview'
import { OssImage } from '@web/components/common/OssImage'
import { Badge } from '@web/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog'
import { ScrollArea } from '@web/components/ui/scroll-area'
import { usePlanDetailStore } from '@web/store/draft-box/planDetailStore'
import { cn } from '@web/utils/className'
import { formatRelativeTime } from '@web/utils/format'
import { getOssUrl } from '@web/utils/oss'
import { GenerationParamsCard } from '../GenerationParamsCard'
import { LOAD_MORE_OBSERVER_OPTIONS } from '../loadMoreObserver'

function getTaskResponse(task: DraftGenerationTask): DraftGenerationResponse | undefined {
  return task.response && typeof task.response === 'object' ? task.response : undefined
}

const consumedPointsFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
})

function formatConsumedPoints(points: number) {
  return consumedPointsFormatter.format(points)
}

function getStringValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getResponseTitle(response: DraftGenerationResponse) {
  return response.title || getStringValue(response.plan, 'title')
}

function getResponseDescription(response: DraftGenerationResponse) {
  return response.description || getStringValue(response.plan, 'description')
}

function getResponseTopics(response: DraftGenerationResponse) {
  const topics = response.topics ?? response.plan?.topics
  if (!Array.isArray(topics))
    return []
  return topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0)
}

function CopyContentButton({ title, description, topics }: { title?: string; description?: string; topics: string[] }) {
  return (
    <button
      type="button"
      onClick={() => {
        const content = [title, description, ...topics.map(t => `#${t.replace(/^#/, '')}`)].filter(Boolean).join('\n\n')
        void navigator.clipboard?.writeText(content)
          .then(() => toast.success('内容已复制，可直接粘贴发布'))
          .catch(() => toast.error('复制失败'))
      }}
      className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
    >
      <Copy className="h-3.5 w-3.5" />
      复制内容
    </button>
  )
}

function mergeTaskList(current: DraftGenerationTask[], incoming: DraftGenerationTask[]) {
  const taskMap = new Map<string, DraftGenerationTask>()
  current.forEach(task => taskMap.set(task.id, task))
  incoming.forEach((task) => {
    const currentTask = taskMap.get(task.id)
    taskMap.set(task.id, currentTask ? { ...currentTask, ...task } : task)
  })
  return Array.from(taskMap.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

// 状态图标映射
function StatusIcon({ status }: { status: DraftGenerationTask['status'] }) {
  switch (status) {
    case 'generating':
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />
    case 'success':
      return <CheckCircle2 className="h-4 w-4 text-success" />
    case 'partial':
      return <AlertTriangle className="h-4 w-4 text-warning" />
    case 'failed':
      return <AlertCircle className="h-4 w-4 text-destructive" />
  }
}

// 状态 Badge 变体映射
function getStatusVariant(status: DraftGenerationTask['status']): 'default' | 'secondary' | 'destructive' {
  switch (status) {
    case 'generating':
      return 'default'
    case 'success':
      return 'secondary'
    case 'partial':
      return 'default'
    case 'failed':
      return 'destructive'
  }
}

function getStatusClassName(status: DraftGenerationTask['status']) {
  if (status === 'generating')
    return 'border-primary/20 bg-primary/10 text-primary shadow-none'
  if (status === 'partial')
    return 'border-warning/40 bg-warning/10 text-warning shadow-none'
}

// 任务条目
const TaskItem = memo(({
  task,
  t,
  applyTargetGroupId,
  onApplied,
  onDelete,
}: {
  task: DraftGenerationTask
  t: (key: string, options?: Record<string, unknown>) => string
  applyTargetGroupId?: string | null
  onApplied?: () => void
  onDelete: (taskId: string) => void
}) => {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewIndex, setPreviewIndex] = useState(0)
  const response = getTaskResponse(task)

  // 构建预览项列表和封面
  const hasVideo = !!response?.videoUrl
  const hasImages = (response?.imageUrls?.length ?? 0) > 0
  const coverSrc = response?.coverUrl
    ? getOssUrl(response.coverUrl)
    : response?.imageUrls?.[0]
      ? getOssUrl(response.imageUrls[0])
      : undefined
  const title = response ? getResponseTitle(response) : ''
  const description = response ? getResponseDescription(response) : ''
  const topics = response ? getResponseTopics(response) : []
  // 请求张数只有生成任务入参这一份权威来源：服务端不写响应侧的同名字段。
  const requestedImageCount = task.request?.imageCount ?? 0

  // 预览项：视频任务只预览视频，图片任务预览所有图片
  const previewItems = response
    ? hasVideo && response.videoUrl
      ? [{ type: 'video' as const, src: getOssUrl(response.videoUrl), title }]
      : (response.imageUrls || []).map(url => ({ type: 'image' as const, src: getOssUrl(url), title }))
    : []

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border border-border/50 bg-muted/20">
      <div className="mt-0.5">
        <StatusIcon status={task.status} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={getStatusVariant(task.status)} className={cn('text-xs', getStatusClassName(task.status))}>
            {t(`detail.taskStatus.${task.status}`)}
          </Badge>
          {task.points > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('detail.pointsConsumed', { points: formatConsumedPoints(task.points) })}
            </span>
          )}
        </div>

        {/* 请求参数 */}
        {task.request && (
          <GenerationParamsCard
            params={task.request}
            t={t}
            className="mt-2"
            compact
            applyTargetGroupId={applyTargetGroupId}
            onApplied={onApplied}
          />
        )}

        {/* 已生成的部分结果 */}
        {response && (
          <div className="mt-2">
            {requestedImageCount > 0 && (
              <p className="mb-2 text-xs text-muted-foreground">
                {t('detail.generatedImageProgress', {
                  generated: response.generatedImageCount ?? response.imageUrls?.length ?? 0,
                  requested: requestedImageCount,
                })}
              </p>
            )}

            {/* 视频任务：封面 + 文字信息 */}
            {hasVideo && coverSrc && (
              <div className="flex gap-3">
                <div
                  className="relative shrink-0 w-20 h-20 rounded-md overflow-hidden bg-muted cursor-pointer"
                  onClick={() => { setPreviewIndex(0); setPreviewOpen(true) }}
                >
                  <OssImage
                    src={coverSrc}
                    alt={title || ''}
                    fill
                    className="object-cover"
                    sizes="80px"
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <Play className="h-5 w-5 text-white fill-white" />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  {title && (
                    <p className="text-sm font-medium whitespace-pre-wrap break-words">{title}</p>
                  )}
                  {description && (
                    <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words mt-0.5">{description}</p>
                  )}
                  {topics.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {topics.map(topic => (
                        <span key={topic} className="text-xs text-primary">
                          #
                          {topic}
                        </span>
                      ))}
                    </div>
                  )}
                      <CopyContentButton title={title} description={description} topics={topics} />
                </div>
              </div>
            )}

            {/* 图片任务：展示所有生成图片 */}
            {!hasVideo && hasImages && (
              <div className="mt-2">
                {title && (
                  <p className="text-base font-semibold">{title}</p>
                )}
                {description && (
                  <p className="mt-2 text-sm leading-6 whitespace-pre-wrap break-words">{description}</p>
                )}
                {topics.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {topics.map(topic => (
                      <span key={topic} className="text-xs text-primary">
                        #
                        {topic.replace(/^#/, '')}
                      </span>
                    ))}
                  </div>
                )}
                <div className="overflow-x-auto max-w-full mt-2">
                  <div className="flex gap-1.5">
                    {(response.imageUrls ?? []).map((url, i) => (
                      <div
                        key={i}
                        className="relative w-20 h-20 rounded-md overflow-hidden bg-muted cursor-pointer"
                        onClick={() => { setPreviewIndex(i); setPreviewOpen(true) }}
                      >
                        <OssImage
                          src={getOssUrl(url)}
                          alt={`result-${i + 1}`}
                          fill
                          className="object-cover"
                          sizes="80px"
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <CopyContentButton title={title} description={description} topics={topics} />
              </div>
            )}

            {/* 纯文本生成结果（图文/脚本无媒体时仍展示标题正文话题） */}
            {!hasVideo && !hasImages && (
              <div className="mt-2">
                {title && (
                  <p className="text-base font-semibold">{title}</p>
                )}
                {description && (
                  <p className="mt-2 text-sm leading-6 whitespace-pre-wrap break-words">{description}</p>
                )}
                {topics.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {topics.map(topic => (
                      <span key={topic} className="text-xs text-primary">
                        #
                        {topic.replace(/^#/, '')}
                      </span>
                    ))}
                  </div>
                )}
                <CopyContentButton title={title} description={description} topics={topics} />
              </div>
            )}

            {/* 预览 */}
            {previewItems.length > 0 && (
              <MediaPreview
                open={previewOpen}
                items={previewItems}
                initialIndex={previewIndex}
                onClose={() => setPreviewOpen(false)}
              />
            )}
          </div>
        )}

        {task.errorMessage && task.status === 'failed' && (
          <p className="text-xs text-destructive mt-1 break-all">{task.errorMessage}</p>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {formatRelativeTime(new Date(task.createdAt))}
        </p>
      </div>
      <button
        type="button"
        aria-label="删除生成记录"
        className="mt-0.5 shrink-0 cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        onClick={(event) => {
          event.stopPropagation()
          onDelete(task.id)
        }}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
})

TaskItem.displayName = 'TaskItem'

// 弹框内容
const GenerationDetailContent = memo(({
  onClose,
  applyTargetGroupId,
}: {
  onClose: () => void
  applyTargetGroupId?: string | null
}) => {
  const { t } = useTransClient('brandPromotion')
  const deleteGenerationTasks = usePlanDetailStore(state => state.deleteGenerationTasks)
  const clearGenerationTasks = usePlanDetailStore(state => state.clearGenerationTasks)
  const [tasks, setTasks] = useState<DraftGenerationTask[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(true)
  const [page, setPage] = useState(1)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const pageSize = 20
  const liveGenerationTasks = usePlanDetailStore(state => state.generationTasks)

  const fetchTasks = useCallback(async (pageNum: number) => {
    setLoading(true)
    try {
      const res = await apiGetDraftGenerationList(pageNum, pageSize)
      if (res?.data) {
        const list = res.data.list || []
        setTasks(prev => pageNum === 1 ? list : [...prev, ...list])
        setHasMore(list.length === pageSize)
      }
    }
    catch {
      // 静默失败
    }
    finally {
      setLoading(false)
    }
  }, [])

  const handleDeleteTask = useCallback(async (taskId: string) => {
    const confirmed = await confirm({
      title: '删除生成记录',
      content: '确定删除这条生成记录吗？此操作不可恢复。',
      okType: 'destructive',
      okText: '删除',
    })
    if (!confirmed)
      return
    const ok = await deleteGenerationTasks([taskId])
    if (ok) {
      setTasks(prev => prev.filter(task => task.id !== taskId))
      toast.success('已删除生成记录')
    }
    else {
      toast.error('删除生成记录失败')
    }
  }, [deleteGenerationTasks])

  const handleClearAll = useCallback(async () => {
    const confirmed = await confirm({
      title: '清空全部生成记录',
      content: '确定清空全部生成记录吗？此操作不可恢复。',
      okType: 'destructive',
      okText: '清空',
    })
    if (!confirmed)
      return
    const ok = await clearGenerationTasks()
    if (ok) {
      setTasks([])
      toast.success('已清空全部生成记录')
    }
    else {
      toast.error('清空生成记录失败')
    }
  }, [clearGenerationTasks])

  // 初始加载
  useEffect(() => {
    fetchTasks(1)
  }, [fetchTasks])

  useEffect(() => {
    if (liveGenerationTasks.length === 0)
      return
    setTasks(prev => mergeTaskList(prev, liveGenerationTasks))
  }, [liveGenerationTasks])

  // IntersectionObserver 无限滚动
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el)
      return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          const nextPage = page + 1
          setPage(nextPage)
          fetchTasks(nextPage)
        }
      },
      LOAD_MORE_OBSERVER_OPTIONS,
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, page, fetchTasks])

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('detail.generationDetailTitle')}</DialogTitle>
        <button
          type="button"
          className="mt-2 inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
          onClick={() => void handleClearAll()}
        >
          <Trash2 className="h-3.5 w-3.5" />
          清空全部
        </button>
      </DialogHeader>

      <ScrollArea className="max-h-[60vh]">
        <div className="space-y-2 pr-2">
          {tasks.map(task => (
            <TaskItem
              key={task.id}
              task={task}
              t={t}
              applyTargetGroupId={applyTargetGroupId}
              onApplied={onClose}
              onDelete={handleDeleteTask}
            />
          ))}

          {/* 加载触发器 */}
          <div ref={loadMoreRef} className="h-px" />

          {/* 加载中 */}
          {loading && (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* 空状态 */}
          {!loading && tasks.length === 0 && (
            <div className="flex justify-center py-8 text-sm text-muted-foreground">
              {t('detail.noGenerationTasks')}
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  )
})

GenerationDetailContent.displayName = 'GenerationDetailContent'

export const GenerationDetailDialog = memo(() => {
  const { generationDetailDialogOpen, closeGenerationDetailDialog, currentPlanId } = usePlanDetailStore(
    useShallow(state => ({
      generationDetailDialogOpen: state.generationDetailDialogOpen,
      closeGenerationDetailDialog: state.closeGenerationDetailDialog,
      currentPlanId: state.currentPlan?.id ?? null,
    })),
  )

  // 两层组件模式
  if (!generationDetailDialogOpen)
    return null

  return (
    <Dialog open onOpenChange={closeGenerationDetailDialog}>
      <DialogContent data-testid="draftbox-generation-detail-dialog" className="sm:max-w-2xl">
        <GenerationDetailContent
          onClose={closeGenerationDetailDialog}
          applyTargetGroupId={currentPlanId}
        />
      </DialogContent>
    </Dialog>
  )
})

GenerationDetailDialog.displayName = 'GenerationDetailDialog'
