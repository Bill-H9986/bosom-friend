/**
 * 生成中卡片
 * 显示在瀑布流中，展示正在生成的草稿数量，带 shimmer 渐变动画
 */

'use client'

import type { DraftGenerationResponse, DraftGenerationTask } from '@web/api/ai/ai.types'
import { AlertCircle, Ban, ImageIcon, Loader2, Play, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { apiCreateDraftGeneration, apiCreateImageTextDraft, apiResumeLongVideo } from '@web/api/ai/ai.api'
import { useTransClient } from '@web/app/i18n/client'
import { toast } from '@web/utils/ui/toast'
import { MorphingIcon } from '@web/components/common/MorphingIcon'
import { OssImage } from '@web/components/common/OssImage'
import { Badge } from '@web/components/ui/badge'
import { cn } from '@web/utils/className'
import styles from './GeneratingCard.module.scss'

interface GeneratingCardProps {
  count: number
  onClick: () => void
}

interface GeneratingTaskCardProps {
  task: DraftGenerationTask
  onClick: () => void
  onDelete?: (taskId: string) => void
}

function getResponseObject(task: DraftGenerationTask): DraftGenerationResponse | undefined {
  return task.response && typeof task.response === 'object' ? task.response : undefined
}

function getStringValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getTaskTitle(task: DraftGenerationTask) {
  const response = getResponseObject(task)
  const plan = response?.plan
  return response?.title || getStringValue(plan, 'title')
}

function getTaskDescription(task: DraftGenerationTask) {
  const response = getResponseObject(task)
  const plan = response?.plan
  return response?.description || getStringValue(plan, 'description')
}

function getTaskTopics(task: DraftGenerationTask) {
  const response = getResponseObject(task)
  const topics = response?.topics ?? response?.plan?.topics
  if (!Array.isArray(topics))
    return []
  return topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0)
}

export function getDraftGenerationTaskTarget(task: DraftGenerationTask): 'draft' | 'video' | 'img' {
  if (task.request?.draftType === 'video')
    return 'video'
  if (task.request?.draftType === 'image')
    return 'img'
  return 'draft'
}

export function hasDraftGenerationTaskPartialResult(task: DraftGenerationTask) {
  const response = getResponseObject(task)
  return Boolean(
    response?.imageUrls?.length
    || response?.videoUrl
    || response?.coverUrl
    || response?.title
    || response?.description
    || response?.plan,
  )
}

export function shouldShowDraftGenerationTaskCard(task: DraftGenerationTask) {
  return task.status === 'generating' || task.status === 'partial'
    || (task.status === 'failed' && hasDraftGenerationTaskPartialResult(task))
}

export const GeneratingCard = memo(({ count, onClick }: GeneratingCardProps) => {
  const { t } = useTransClient('brandPromotion')

  if (count <= 0)
    return null

  return (
    <div
      data-testid="draftbox-generating-card"
      className={cn(
        'mb-4 h-[160px] rounded-lg border border-primary/20 bg-primary/5 overflow-hidden cursor-pointer transition-all duration-300 hover:border-primary/40',
        styles.generatingCard,
      )}
      onClick={onClick}
    >
      <div className="flex flex-col items-center justify-center h-full gap-4 relative z-10">
        <MorphingIcon size={32} />
        <span className="text-sm text-muted-foreground">
          {t('detail.generatingDrafts', { count })}
        </span>
      </div>
    </div>
  )
})

GeneratingCard.displayName = 'GeneratingCard'

export const GeneratingTaskCard = memo(({ task, onClick, onDelete }: GeneratingTaskCardProps) => {
  const { t } = useTransClient('brandPromotion')
  const response = getResponseObject(task)
  const imageUrls = response?.imageUrls?.filter(Boolean) ?? []
  const coverUrl = response?.coverUrl || imageUrls[0]
  const generatedCount = response?.generatedImageCount ?? imageUrls.length
  const requestedCount = task.request?.imageCount
  const title = getTaskTitle(task) || t('detail.generatingTaskTitle')
  const description = getTaskDescription(task)
  const topics = getTaskTopics(task)
  const modelName = task.request?.model || task.request?.imageModel
  /**
   * 服务端在生成过程中给出的**前置提醒**（例如"只上传了 1 张参考图，厂商会把画面锁死在这张图上，
   * 提示词里的场景不会生效"）。它落在生成记录里，轮询时带回来——必须在卡片上显示出来，
   * 否则用户只能对着一条跑偏的片子猜原因。
   */
  const serverWarning = String((typeof response === 'object' && response !== null
    ? (response as { warning?: unknown }).warning
    : '') ?? '')
  const isFailed = task.status === 'failed'
  const isGenerating = task.status === 'generating'
  const isPartial = task.status === 'partial'
  const showImageGrid = imageUrls.length > 0
  const showVideoCover = !showImageGrid && (coverUrl || response?.videoUrl)
  // 分段生成时长片的实时进度：内容创作界面上此前只有"生成中"，用户不知道跑到哪一步。
  const progress = task.progress
  // 百分比用后端算好的**全流程完成度**：镜头出完还要合成与落盘，那时才接近 100%。
  const progressPct = progress === undefined ? 0 : Math.min(100, Math.max(0, progress.percent))
  // 成功后同样要能看出"这条片子一共几镜"（E11）：此前文案只在生成中渲染，
  // 成片出来就只剩一句说明，用户无从判断这条片子切了几刀。
  const progressLabel = progress === undefined
    ? ''
    : progress.shotsTotal === 0
      ? progress.stage + ' · ' + String(progressPct) + '%'
      : '共 ' + String(progress.shotsTotal) + ' 镜'
        + (isGenerating
          ? ' · ' + progress.stage + ' ' + String(progress.shotsReady) + ' 镜已好 · ' + String(progressPct) + '%'
          : '')
  /**
   * 卡片尺寸：沿边框画进度需要具体像素（SVG 的 rect 不支持 calc 百分比）。
   * 卡片宽度随栅格变化，所以要跟着量，不能写死。
   */
  /** 续跑/重生成进行中：按钮置灰，避免连点重复下单。 */
  const [acting, setActing] = useState(false)
  /** 被中断的分段任务 id：有它才谈得上"断点继续"。 */
  const linkedTaskId = String((typeof response === 'object' && response !== null
    ? (response as { longVideoTaskId?: unknown }).longVideoTaskId
    : '') ?? '')

  /**
   * 断点继续：让分段任务从已完成的镜头接着跑（已生成的镜头不会重跑）。
   */
  const handleResume = useCallback(async () => {
    if (linkedTaskId === '' || acting) return
    setActing(true)
    try {
      const res = await apiResumeLongVideo(linkedTaskId)
      if (res?.code !== 0) { toast.error(res?.message || '继续生成失败'); return }
      toast.success('已从断点继续：剩余 ' + String(res.data?.remaining ?? 0) + ' 个镜头')
    }
    catch { toast.error('继续生成失败，请稍后再试') }
    finally { setActing(false) }
  }, [acting, linkedTaskId])

  /**
   * 重新生成：用这次请求的原参数重下一单（新任务，不复用已生成的镜头）。
   */
  const handleRetry = useCallback(async () => {
    if (acting) return
    const request = task.request
    if (request === undefined) { toast.error('这条记录没有可复用的参数'); return }
    setActing(true)
    try {
      const payload = { ...request } as Record<string, unknown>
      delete payload.kind
      // 「重新生成」重生成的是**这一条**：批量数量不能跟着复用到新任务，
      // 否则批量选 3 条时点一次会新增 3 条任务、白烧额度（2026-09-28 审计）。
      payload.quantity = 1
      const res = request.kind === 'image-text'
        ? await apiCreateImageTextDraft(payload as never)
        : await apiCreateDraftGeneration(payload as never)
      if (res?.code !== 0) { toast.error(res?.message || '重新生成失败'); return }
      toast.success('已按原参数重新生成')
    }
    catch { toast.error('重新生成失败，请稍后再试') }
    finally { setActing(false) }
  }, [acting, task.request])

  const [cardSize, setCardSize] = useState({ width: 0, height: 0 })
  const cardRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = cardRef.current
    if (el === null) return
    const update = () => setCardSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={cardRef}
      data-testid="draftbox-generating-task-card"
      className={cn(
        'group relative mb-4 cursor-pointer overflow-hidden rounded-xl border bg-card transition-all duration-300 hover:border-primary/50',
        isFailed ? 'border-destructive/30' : 'border-primary/20',
      )}
      onClick={onClick}
    >
      {/* 沿卡片边框走的进度条：pathLength=100 把周长归一化，不必算实际长度；
          stroke 居中压在原来的 1px 边框上，观感就是"边框自己在长出来"。 */}
      {isGenerating && progress !== undefined && cardSize.width > 0 && (
        <svg
          data-testid="draftbox-generation-progress-ring"
          className="pointer-events-none absolute left-0 top-0 z-20"
          width={cardSize.width}
          height={cardSize.height}
          aria-hidden
        >
          <rect
            x="1"
            y="1"
            width={Math.max(0, cardSize.width - 2)}
            height={Math.max(0, cardSize.height - 2)}
            rx="11"
            fill="none"
            strokeWidth="2"
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset={100 - progressPct}
            strokeLinecap="round"
            className="stroke-primary transition-all duration-700"
          />
        </svg>
      )}
      {/* 图区与普通卡片同一规格（3:4）：此前是 min-h-132 / h-160 / 方形网格三种形态，
          同一列表里高矮不一，就是"排布太乱"的主因。 */}
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-muted">
        {showImageGrid
          ? (
              <div className={cn('grid h-full w-full gap-1 p-1', imageUrls.length === 1 ? 'grid-cols-1' : 'grid-rows-2 grid-cols-2')}>
                {imageUrls.slice(0, 4).map((url, index) => (
                  <div key={`${url}-${index}`} className="relative overflow-hidden rounded-lg bg-background">
                    <OssImage
                      src={url}
                      alt={t('detail.generatedImageAlt', { index: index + 1 })}
                      fill
                      className="object-cover"
                      sizes="160px"
                    />
                    {index === 3 && imageUrls.length > 4 && (
                      <div className="absolute inset-0 flex items-center justify-center bg-foreground/60 text-sm font-medium text-background">
                        {t('detail.moreGeneratedImages', { count: imageUrls.length - 4 })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          : showVideoCover
            ? (
                <div className="relative h-full w-full">
                  {coverUrl
                    ? (
                        <OssImage
                          src={coverUrl}
                          alt={title}
                          fill
                          className="object-cover"
                          sizes="240px"
                        />
                      )
                    : (
                        <div className="flex h-full items-center justify-center">
                          <ImageIcon className="h-8 w-8 text-muted-foreground" />
                        </div>
                      )}
                  {response?.videoUrl && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/60">
                        <Play className="ml-0.5 h-5 w-5 fill-background text-background" />
                      </div>
                    </div>
                  )}
                </div>
              )
            : (
                <div className={cn('flex h-[160px] flex-col items-center justify-center gap-3', styles.generatingCard)}>
                  <MorphingIcon size={32} />
                  {isGenerating && (
                    <span className="text-sm text-muted-foreground">
                      {t('detail.generatingDraft')}
                    </span>
                  )}
                </div>
              )}

        {/* 失败/部分成功时给用户三个出口（BFS-104.4）：断点继续（不重跑已成的镜）、
            重新生成（新下一单）、放弃（删掉这条记录）。此前只有一句"请重新生成"，
            用户什么也做不了；此前"放弃"藏在右上角的删除图标里，跟"重试"是两处、两个说法。 */}
        {(isFailed || isPartial) && (
          <div className="absolute bottom-2 left-2 right-2 z-10 flex items-center justify-center gap-1">
            {linkedTaskId !== '' && (
              <button
                type="button"
                disabled={acting}
                data-testid="draftbox-generation-resume-btn"
                className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background/95 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                onClick={(event) => { event.stopPropagation(); void handleResume() }}
              >
                {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                断点继续
              </button>
            )}
            <button
              type="button"
              disabled={acting}
              data-testid="draftbox-generation-retry-btn"
              className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background/95 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              onClick={(event) => { event.stopPropagation(); void handleRetry() }}
            >
              <RefreshCw className="h-3 w-3" />
              重新生成
            </button>
            {onDelete !== undefined && (
              <button
                type="button"
                disabled={acting}
                data-testid="draftbox-generation-abandon-btn"
                className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background/95 px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                onClick={(event) => { event.stopPropagation(); onDelete(task.id) }}
              >
                <Ban className="h-3 w-3" />
                放弃
              </button>
            )}
          </div>
        )}

        <Badge
          variant={isFailed ? 'destructive' : 'outline'}
          className={cn(
            'absolute left-2 top-2 gap-1 shadow-none',
            isGenerating && 'border-border/60 bg-background/90 font-medium text-muted-foreground backdrop-blur-sm',
            // 对比度：warning 原色（#f49500）压在 bg-warning/10（#f5ebdd）上只有 1.95:1，
            // 12px 正文需 4.5:1（WCAG2AA）——qa-guard2 的 A11Y-#/draft-box 报 serious。
            // 状态语义由黄底 + 黄边承担，文字改走前景色（与 MaterialValidationAlert 的警示条目同款）。
            isPartial && 'border-warning/40 bg-warning/10 font-medium text-foreground backdrop-blur-sm',
          )}
        >
          {isGenerating
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : isPartial
              ? <AlertCircle className="h-3 w-3" />
            : <AlertCircle className="h-3 w-3" />}
          {t(`detail.taskStatus.${task.status}`)}
        </Badge>
      </div>

      <div className="h-[60px] space-y-1 overflow-hidden p-2.5">
        <div>
          <p className="line-clamp-1 text-sm font-medium text-foreground">{title}</p>
          {/* 失败/部分成功时优先显示**原因**：卡片高度统一后原来排在末尾的错误信息会被裁掉，用户只看到"部分成功"四个字。
              文字色 amber-700 而非 text-warning：#f49500 白底 2.3:1 < 12px 要求的 4.5:1（A11Y-#/draft-box serious），#b45309 为 5.9:1。 */}
          {(isFailed || isPartial) && task.errorMessage
            ? (
                <p className={cn('mt-0.5 line-clamp-2 text-xs', isFailed ? 'text-destructive' : 'text-amber-700')}>
                  {task.errorMessage}
                </p>
              )
            : serverWarning !== ''
              ? <p className="mt-0.5 line-clamp-2 text-xs text-amber-700">{serverWarning}</p>
              : progress !== undefined
                ? <p className="mt-0.5 text-[11px] text-muted-foreground">{progressLabel}</p>
              : description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</p>
              )}
        </div>

        {requestedCount && requestedCount > 0 && (
          <div className="text-xs text-muted-foreground">
            {t('detail.generatedImageProgress', {
              generated: generatedCount,
              requested: requestedCount,
            })}
          </div>
        )}

        {modelName && (
          <Badge variant="secondary" className="rounded-full text-[11px] font-normal">
            {modelName}
          </Badge>
        )}

        {topics.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {topics.slice(0, 4).map(topic => (
              <span key={topic} className="text-xs text-primary">
                #
                {topic}
              </span>
            ))}
          </div>
        )}

        {isFailed && task.errorMessage && (
          <p className="line-clamp-2 text-xs text-destructive">{task.errorMessage}</p>
        )}
        {isPartial && task.errorMessage && (
          <p className="line-clamp-2 text-xs text-amber-700">{task.errorMessage}</p>
        )}
        {onDelete && (
          <button
            type="button"
            data-testid="draftbox-generation-delete-btn"
            aria-label="删除生成记录"
            className="absolute right-2 top-2 z-10 inline-flex cursor-pointer items-center gap-1 rounded-md border bor opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100der-border bg-background/90 px-2 py-1 text-xs text-muted-foreground backdrop-blur-sm transition-colors hover:border-destructive/40 hover:text-destructive"
            onClick={(event) => {
              event.stopPropagation()
              onDelete(task.id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除记录
          </button>
        )}
      </div>
    </div>
  )
})

GeneratingTaskCard.displayName = 'GeneratingTaskCard'
