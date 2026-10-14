/**
 * TaskHistoryList - 可复用的任务卡片列表组件
 * 用于在不同页面展示任务网格，支持 loading skeleton、删除、评分回调和可选链接包裹
 */
'use client'

import type { TaskListItem } from '@web/api/ai/ai.types'
import Link from '@web/next-shims/link'
import React, { useCallback, useState } from 'react'
import { agentApi } from '@web/api/ai/ai.api'
import { useAgentStore } from '@web/store/agent'
import { useTransClient } from '@web/app/i18n/client'
import { Trash2 } from 'lucide-react'
import { Button } from '@web/components/ui/button'
import { TaskCard, TaskCardSkeleton } from '@web/components/Chat'
import { FailureActions } from '@web/components/Chat/FailureActions'
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
  // 删除任务时一并清掉右侧助手里那份对话：两个面板必须对同一份数据说同一句话。
  const forgetTasks = useAgentStore(state => state.forgetTasks)
  const [ratingModalFor, setRatingModalFor] = useState<string | null>(null)
  const [shareTaskId, setShareTaskId] = useState<string | null>(null)
  // 本地任务状态（用于乐观更新），初始值使用 props.tasks 避免首次渲染时空页面闪烁
  const [localTasks, setLocalTasks] = useState<TaskListItem[]>(tasks)
  // 批量管理模式：勾选后一次性删除，避免逐条点删除的重复劳动。
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [deleting, setDeleting] = useState(false)
  /** 失败态三选择（BFS-104.4）正在执行的任务 id，用来置灰按钮防连点。 */
  const [failureBusyId, setFailureBusyId] = useState('')

  // 同步外部 tasks 到 localTasks
  React.useEffect(() => {
    setLocalTasks(tasks)
  }, [tasks])


  /** 处理删除任务 */
  const handleDelete = async (id: string) => {
    try {
      const result = await agentApi.deleteTask(id)
      if (result && result.code === 0) {
        // 记录删了，右侧助手不能还留着那条对话（否则两个面板对同一份数据给出相反的说法）。
        forgetTasks([id])
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
        // 同上：删掉的记录连同它在右侧助手里的那份对话一起清掉。
        forgetTasks(selectedIds)
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

  /**
   * 失败态三选择（BFS-104.4 / 方案 M8）：任务列表是用户看失败任务最集中的地方，
   * 此前这里只有一个红色的"失败"标签和一句原因，什么也做不了。
   *
   * - 断点继续：把这条任务的**标题**接着发给同一个任务（任务上的标题就是当初那句话）；
   * - 重新生成：同样用标题**开一条新任务**，旧任务原样留着便于对照；
   * - 放弃：删掉这条记录——与卡片上的删除是同一件事，只是在这里叫得更明白。
   *
   * 三条都只有在本组件能拿到标题时才显示（标题为空就不长按钮，不给一个点了没反应的入口）。
   */
  const runFailureAction = useCallback(async (taskId: string, prompt: string, kind: 'continue' | 'regenerate') => {
    if (prompt.trim() === '' || failureBusyId !== '')
      return
    setFailureBusyId(taskId)
    try {
      const agent = useAgentStore.getState()
      if (kind === 'continue')
        await agent.continueTask({ taskId, prompt, t: t as unknown as (key: string) => string })
      else
        await agent.createTask({ prompt, t: t as unknown as (key: string) => string })
      // 新任务/续跑都会改任务列表，拉一次让这一页跟上（父组件若给了 onRefresh 就用它的）。
      if (onRefresh)
        await onRefresh()
    }
    catch {
      toast.error(kind === 'continue' ? '继续失败，稍后再试一次' : '重新生成失败，稍后再试一次')
    }
    finally {
      setFailureBusyId('')
    }
  }, [failureBusyId, onRefresh, t])

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
                  agentRole={task.agentRole}
                  errorMessage={task.errorMessage}
                  usage={task.usage}
                  createdAt={task.createdAt}
                  updatedAt={task.updatedAt}
                  rating={task.rating}
                  isFavorited={!!task.favoritedAt}
                  onDelete={() => handleDelete(id)}
                  onRateClick={() => setRatingModalFor(task.id)}
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

              // 失败态的三选择挂在卡片**下面**，不塞进卡片：卡片本身已经点了就跳对话，
              // 里面再放三个动作会让"点卡片"和"点按钮"两个热区打架。
              const failureRow = !batchMode
                && (String(task.status).toLowerCase() === 'error' || String(task.status).toLowerCase() === 'failed')
                && (task.title ?? '').trim() !== ''
                ? (
                    <FailureActions
                      className="mt-2"
                      busy={failureBusyId === id}
                      onContinue={() => void runFailureAction(id, task.title ?? '', 'continue')}
                      onRegenerate={() => void runFailureAction(id, task.title ?? '', 'regenerate')}
                      onAbandon={() => void handleDelete(id)}
                    />
                  )
                : null

              if (linkBasePath) {
                const href = `${linkBasePath}/${task.id}` as string
                return (
                  <div key={task.id}>
                    <Link href={href} className="block">
                      {/* 传递 onSelect 来阻止 TaskCard 内部的 router.push，由 Link 处理导航 */}
                      {React.cloneElement(card, { onSelect: () => {} })}
                    </Link>
                    {failureRow}
                  </div>
                )
              }

              return (
                <React.Fragment key={task.id}>
                  {card}
                  {failureRow}
                </React.Fragment>
              )
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
