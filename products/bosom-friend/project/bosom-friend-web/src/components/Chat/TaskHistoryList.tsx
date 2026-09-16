/**
 * TaskHistoryList - 可复用的任务卡片列表组件
 * 用于在不同页面展示任务网格，支持 loading skeleton、删除、评分回调和可选链接包裹
 */
'use client'

import type { TaskListItem } from '@web/api/ai/ai.types'
import Link from '@web/next-shims/link'
import React, { useCallback, useState } from 'react'
import { agentApi } from '@web/api/ai/ai.api'
import { useTransClient } from '@web/app/i18n/client'
import { Trash2 } from 'lucide-react'
import { Button } from '@web/components/ui/button'
import { TaskCard, TaskCardSkeleton } from '@web/components/Chat'
import RatingModal from '@web/components/Chat/Rating'
import ShareModal from '@web/components/Chat/Share/ShareModal'
import { cn } from '@web/utils/className'
import { confirm } from '@web/utils/ui/confirm'
import { toast } from '@web/utils/ui/toast'

export interface ITaskHistoryListProps {
  tasks: TaskListItem[]
  isLoading?: boolean
  skeletonCount?: number
  /** 刷新列表回调，由父组件提供 */
  onRefresh?: () => void | Promise<void>
  className?: string
  /** 可选：为每条记录生成链接的前缀（例如 '/en/chat'），若传入则会用 <a> 包裹 TaskCard */
  linkBasePath?: string
  /** 是否提供批量管理入口；缺省提供（删除能力由本组件自己完成并回调 onRefresh）。 */
  batchSelectable?: boolean
}

export function TaskHistoryList({
  tasks,
  isLoading = false,
  skeletonCount = 4,
  onRefresh,
  className,
  linkBasePath = '/chat',
  batchSelectable = true,
}: ITaskHistoryListProps) {
  const { t } = useTransClient('chat')
  const [ratingModalFor, setRatingModalFor] = useState<string | null>(null)
  const [shareTaskId, setShareTaskId] = useState<string | null>(null)
  // 本地任务状态（用于乐观更新），初始值使用 props.tasks 避免首次渲染时空页面闪烁
  const [localTasks, setLocalTasks] = useState<TaskListItem[]>(tasks)
  // 批量管理模式：勾选后一次性删除，避免逐条点删除的重复劳动。
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [deleting, setDeleting] = useState(false)

  // 同步外部 tasks 到 localTasks
  React.useEffect(() => {
    setLocalTasks(tasks)
  }, [tasks])

  const handleRateClick = (taskId: string) => {
    setRatingModalFor(taskId)
  }

  /** 处理删除任务 */
  const handleDelete = async (id: string) => {
    try {
      const result = await agentApi.deleteTask(id)
      if (result && result.code === 0) {
        toast.success(t('task.deleteSuccess' as any))
        // 调用父组件的刷新回调
        if (onRefresh) {
          await onRefresh()
        }
      }
      else {
        toast.error((result as any)?.message || t('task.deleteFailed' as any))
      }
    }
    catch (error) {
      toast.error(t('task.deleteFailed' as any))
    }
  }

  /** 退出批量模式并清空勾选。 */
  const exitBatch = useCallback(() => {
    setBatchMode(false)
    setSelectedIds([])
  }, [])

  /** 勾选/取消勾选一条任务。 */
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]))
  }, [])

  /**
   * 批量删除勾选的任务。
   *
   * 只有后端真的删掉了才提示成功：一条都没删掉时后端回非零码，
   * 这里如实展示原因，不把"没删成"说成"已删除"。
   */
  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.length === 0) {
      toast.warning(t('task.selectRequired'))
      return
    }
    const confirmed = await confirm({
      title: t('task.batchDeleteConfirmTitle'),
      content: t('task.batchDeleteConfirmDesc', { count: selectedIds.length }),
      okType: 'destructive',
      // 命名空间是 'chat'：common.* 的键要走 fallbackNS，写全前缀反而解析不到，界面上会漏出英文键名。
      okText: t('actions.delete'),
      cancelText: t('actions.cancel'),
    })
    if (!confirmed)
      return
    setDeleting(true)
    try {
      const result = await agentApi.deleteTasks(selectedIds)
      if (result && result.code === 0) {
        toast.success(t('task.batchDeleteSuccess', { count: result.data?.deleted ?? selectedIds.length }))
        exitBatch()
        if (onRefresh)
          await onRefresh()
      }
      else {
        toast.error((result as any)?.message || t('task.deleteFailed' as any))
      }
    }
    catch {
      toast.error(t('task.deleteFailed' as any))
    }
    finally {
      setDeleting(false)
    }
  }, [selectedIds, onRefresh, exitBatch, t])

  /** 处理评分更新 */
  const handleRatingUpdate = async (
    taskId: string,
    data: { rating?: number | null, comment?: string | null },
  ) => {
    // 这里可以更新本地状态，或者让父组件处理
    // 由于父组件有自己的状态管理，我们通过 onRefresh 来更新
    if (onRefresh) {
      await onRefresh()
    }
    toast.success(t('rating.saveSuccess' as any) || 'Saved')
  }

  /** 处理收藏切换 - 乐观更新 */
  const handleFavoriteToggle = useCallback(
    async (taskId: string, shouldFavorite: boolean) => {
      // 乐观更新：先改本地 tasks 状态
      setLocalTasks(prev =>
        prev.map(t =>
          t.id === taskId
            ? { ...t, favoritedAt: shouldFavorite ? new Date().toISOString() : null }
            : t,
        ),
      )

      try {
        const result = shouldFavorite
          ? await agentApi.favoriteTask(taskId)
          : await agentApi.unfavoriteTask(taskId)

        if (!result || result.code !== 0) {
          // 失败回滚
          setLocalTasks(prev =>
            prev.map(t =>
              t.id === taskId
                ? { ...t, favoritedAt: shouldFavorite ? null : new Date().toISOString() }
                : t,
            ),
          )
          toast.error((result as any)?.message || t('message.error'))
        }
      }
      catch {
        // 失败回滚
        setLocalTasks(prev =>
          prev.map(t =>
            t.id === taskId
              ? { ...t, favoritedAt: shouldFavorite ? null : new Date().toISOString() }
              : t,
          ),
        )
        toast.error(t('message.error'))
      }
    },
    [t],
  )

  const allSelected = localTasks.length > 0 && selectedIds.length === localTasks.length

  return (
    <div className="flex flex-col gap-3">
      {/* 批量管理入口：逐条点删除在几十条记录时不现实，这里提供一次勾选多条一起删。 */}
      {batchSelectable && !isLoading && localTasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="task-batch-toolbar">
          {batchMode
            ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="task-batch-select-all"
                    onClick={() => setSelectedIds(allSelected ? [] : localTasks.map(item => String(item.id)))}
                  >
                    {allSelected ? t('task.deselectAll') : t('task.selectAll')}
                  </Button>
                  <span className="text-xs text-muted-foreground" data-testid="task-batch-count">
                    {t('task.selectedCount', { count: selectedIds.length, total: localTasks.length })}
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={deleting || selectedIds.length === 0}
                    data-testid="task-batch-delete"
                    onClick={() => void handleBatchDelete()}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    {t('task.deleteSelected')}
                  </Button>
                  <Button variant="ghost" size="sm" data-testid="task-batch-exit" onClick={exitBatch}>
                    {t('task.batchExit')}
                  </Button>
                </>
              )
            : (
                <Button variant="outline" size="sm" data-testid="task-batch-enter" onClick={() => setBatchMode(true)}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  {t('task.batchManage')}
                </Button>
              )}
        </div>
      )}

      <div className={cn('grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4', className)}>
        {isLoading
          ? Array.from({ length: skeletonCount }).map((_, index) => <TaskCardSkeleton key={index} />)
          : localTasks.map((task) => {
              const id = String(task.id)
              const card = (
                <TaskCard
                  key={task.id}
                  id={id}
                  title={task.title ?? ''}
                  status={task.status}
                  createdAt={task.createdAt}
                  updatedAt={task.updatedAt}
                  rating={task.rating}
                  isFavorited={!!task.favoritedAt}
                  onDelete={() => handleDelete(id)}
                  onRateClick={() => handleRateClick(task.id)}
                  onShare={() => setShareTaskId(id)}
                  onFavoriteToggle={handleFavoriteToggle}
                />
              )

              // 批量模式下卡片只负责勾选，不再跳转：否则一点就离开列表，勾不动。
              if (batchMode) {
                const selected = selectedIds.includes(id)
                return (
                  <div
                    key={task.id}
                    data-testid={`task-batch-item-${id}`}
                    className={cn(
                      'relative cursor-pointer rounded-xl transition-shadow',
                      selected ? 'ring-2 ring-primary' : 'hover:ring-2 hover:ring-primary/40',
                    )}
                    onClick={() => toggleSelected(id)}
                  >
                    {React.cloneElement(card, { onSelect: () => toggleSelected(id) })}
                    <span
                      className={cn(
                        'absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border text-[11px]',
                        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-background/80',
                      )}
                      aria-hidden
                    >
                      {selected ? '✓' : ''}
                    </span>
                  </div>
                )
              }

              if (linkBasePath) {
                const href = `${linkBasePath}/${task.id}` as string
                return (
                  <Link key={task.id} href={href} className="block">
                    {/* 传递 onSelect 来阻止 TaskCard 内部的 router.push，由 Link 处理导航 */}
                    {React.cloneElement(card, { onSelect: () => {} })}
                  </Link>
                )
              }

              return <React.Fragment key={task.id}>{card}</React.Fragment>
            })}
      </div>

      <RatingModal
        taskId={ratingModalFor ?? ''}
        open={!!ratingModalFor}
        onClose={() => setRatingModalFor(null)}
        onSaved={(data) => {
          if (ratingModalFor) {
            handleRatingUpdate(ratingModalFor, data)
          }
          setRatingModalFor(null)
        }}
      />
      {/* ShareModal centralized here to avoid overlay click propagation issues */}
      <ShareModal
        taskId={shareTaskId ?? ''}
        open={!!shareTaskId}
        onOpenChange={(v) => {
          if (!v)
            setShareTaskId(null)
        }}
      />
    </div>
  )
}

export default TaskHistoryList
