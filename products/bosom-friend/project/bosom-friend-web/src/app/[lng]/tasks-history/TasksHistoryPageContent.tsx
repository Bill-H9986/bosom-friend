/**
 * 任务记录页内容组件 - Tasks History Content
 * 客户端组件，包含所有交互逻辑
 * 支持搜索任务标题和收藏筛选功能
 */
'use client'

import type { TaskListItem } from '@web/api/ai/ai.types'
import { ArrowLeft, FileText, FileVideo, History, RefreshCw, Search, Star, Trash2, X } from 'lucide-react'
import { useParams, useRouter } from '@web/next-shims/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { agentApi } from '@web/api/ai/ai.api'
import { useTransClient } from '@web/app/i18n/client'
import { PageShell } from '@web/app/layout/PageShell'
import { TaskCardSkeleton } from '@web/components/Chat'
import TaskHistoryList from '@web/components/Chat/TaskHistoryList'
import { EmptyState } from '@web/components/common/EmptyState'
import { Button } from '@web/components/ui/button'
import { Input } from '@web/components/ui/input'
import { useAiAssistantStore } from '@web/store/aiAssistant'
import { cn } from '@web/utils/className'
import { toast } from '@web/utils/ui/toast'
import UserLogsModal from './components/UserLogsModal'
import VideoHistoryModal from './components/VideoHistoryModal'

export function TasksHistoryPageContent({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTransClient('chat')
  const router = useRouter()
  const { lng } = useParams()

  // 状态
  const [tasks, setTasks] = useState<TaskListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [logsModalOpen, setLogsModalOpen] = useState(false)
  const [videoHistoryModalOpen, setVideoHistoryModalOpen] = useState(false)
  const [isCleaningRunning, setIsCleaningRunning] = useState(false)

  // 搜索和筛选状态
  const [searchKeyword, setSearchKeyword] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const filterRef = useRef({ searchKeyword: '', favoriteOnly: false })

  // 任务记录统一一页纵向滚动，不做左右翻页。
  const pageSize = 1000

  // 判断是否有筛选条件
  const hasFilters = searchKeyword.trim() || favoriteOnly

  /** 加载任务列表（分页） */
  const loadTasks = useCallback(
    async (keyword?: string, onlyFavorites?: boolean) => {
      setIsLoading(true)
      try {
        const result = await agentApi.getTaskList({
          page: 1,
          pageSize,
          keyword: keyword?.trim() || undefined,
          favoriteOnly: onlyFavorites || undefined,
        })
        if (result && result.code === 0 && result.data) {
          const newTasks = result.data.list || []
          setTasks(newTasks)
        }
      }
      catch (error) {
        console.error('任务列表加载失败：', error)
        toast.error(t('message.error'))
      }
      finally {
        setIsLoading(false)
      }
    },
    [pageSize, t],
  )

  /** 初始加载 */
  useEffect(() => {
    filterRef.current = { searchKeyword, favoriteOnly }
    loadTasks(searchKeyword, favoriteOnly)
    // 页面可见/窗口聚焦时自动刷新，确保 Agent 新任务及时出现
    const refreshOnVisible = () => {
      if (document.visibilityState === 'visible') {
        const latest = filterRef.current
        loadTasks(latest.searchKeyword, latest.favoriteOnly)
      }
    }
    window.addEventListener('focus', refreshOnVisible)
    document.addEventListener('visibilitychange', refreshOnVisible)
    const timer = window.setInterval(refreshOnVisible, 30_000)
    return () => {
      window.removeEventListener('focus', refreshOnVisible)
      document.removeEventListener('visibilitychange', refreshOnVisible)
      window.clearInterval(timer)
    }
  }, [])

  // 同步最新筛选状态到 ref，供自动刷新使用
  useEffect(() => {
    filterRef.current = { searchKeyword, favoriteOnly }
  }, [searchKeyword, favoriteOnly])

  /** 搜索防抖处理 */
  const handleSearchChange = (value: string) => {
    setSearchKeyword(value)

    // 清除之前的定时器
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // 设置 500ms 防抖
    debounceTimerRef.current = setTimeout(() => {
      loadTasks(value, favoriteOnly)
    }, 500)
  }

  /** 清除搜索 */
  const handleClearSearch = () => {
    setSearchKeyword('')
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    loadTasks('', favoriteOnly)
  }

  /** 切换收藏筛选 */
  const handleToggleFavoriteOnly = () => {
    const newValue = !favoriteOnly
    setFavoriteOnly(newValue)
    loadTasks(searchKeyword, newValue)
  }

  /** 清除所有筛选 */
  const handleClearFilters = () => {
    setSearchKeyword('')
    setFavoriteOnly(false)
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    loadTasks('', false)
  }

  /** 刷新列表，保持当前筛选条件 */
  const handleRefresh = () => {
    loadTasks(searchKeyword, favoriteOnly)
  }

  /** 清理运行中的任务（清除历史卡死的"运行中"假状态） */
  const handleCleanupRunning = async () => {
    if (isCleaningRunning)
      return
    setIsCleaningRunning(true)
    try {
      const result = await agentApi.cleanupRunningTasks()
      const updatedCount = result?.data?.updatedCount ?? 0
      toast.success(`已清理 ${updatedCount} 条运行中任务`)
      handleRefresh()
    }
    catch (error) {
      console.error('清理运行中任务失败：', error)
      toast.error(t('message.error'))
    }
    finally {
      setIsCleaningRunning(false)
    }
  }

  /** 空态“开始对话”：展开右侧 AI 智能体面板 */
  const handleBack = () => {
    useAiAssistantStore.getState().setCollapsed(false)
  }

  /** 打开日志弹窗 */
  const handleOpenLogs = () => {
    setLogsModalOpen(true)
  }

  /** 打开视频历史弹窗 */
  const handleOpenVideoHistory = () => {
    setVideoHistoryModalOpen(true)
  }

  const toolbar = (
    <div className="mx-auto flex w-full max-w-6xl items-center gap-3">
      {/* 搜索框 */}
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder={t('history.searchPlaceholder')}
          value={searchKeyword}
          onChange={e => handleSearchChange(e.target.value)}
          className="pl-9 pr-9 border-0 bg-muted/50 focus-visible:ring-0 focus-visible:bg-muted"
        />
        {searchKeyword && (
          <button
            type="button"
            onClick={handleClearSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* 筛选按钮区域 */}
      <div className="flex items-center gap-2 shrink-0">
        {/* 日志 */}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleOpenLogs}
          className="w-8 h-8"
          title={t('history.logs')}
        >
          <FileText className="w-4 h-4" />
        </Button>
        {/* 视频历史 */}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleOpenVideoHistory}
          className="w-8 h-8"
          title={t('history.videoHistory')}
        >
          <FileVideo className="w-4 h-4" />
        </Button>
        {/* 刷新 */}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
          disabled={isLoading}
          className="w-8 h-8"
          title={t('history.refresh')}
          aria-label={t('history.refresh')}
        >
          <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
        </Button>
        {/* 清理运行中任务 */}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleCleanupRunning}
          disabled={isCleaningRunning}
          className="w-8 h-8 cursor-pointer text-muted-foreground hover:text-foreground"
          title={t('history.cleanupRunning')}
        >
          <Trash2 className={cn('w-4 h-4', isCleaningRunning && 'animate-pulse')} />
        </Button>
        {/* 收藏筛选按钮 */}
        <Button
          variant={favoriteOnly ? 'default' : 'outline'}
          size="sm"
          onClick={handleToggleFavoriteOnly}
          className="h-8 gap-1.5 cursor-pointer text-sm"
        >
          <Star className={cn('w-4 h-4', favoriteOnly && 'fill-current')} />
          <span className="hidden sm:inline">{t('history.favoriteOnly')}</span>
        </Button>

        {/* 清除筛选按钮 */}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearFilters}
            className="text-muted-foreground hover:text-foreground cursor-pointer hidden sm:flex"
          >
            {t('history.clearFilters')}
          </Button>
        )}
      </div>
    </div>
  )

  const content = (
    <div className="mx-auto w-full max-w-6xl">
      {isLoading ? (
        // 加载骨架屏
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 12 }).map((_, index) => (
            <TaskCardSkeleton key={index} />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        favoriteOnly
          ? (
              <EmptyState
                icon={<Star className="h-6 w-6" />}
                title={t('history.emptyFavorites')}
                action={<Button onClick={handleClearFilters} className="cursor-pointer">{t('history.clearFilters')}</Button>}
              />
            )
          : searchKeyword.trim()
            ? (
                <EmptyState
                  icon={<Search className="h-6 w-6" />}
                  title={t('history.emptySearch')}
                  action={<Button onClick={handleClearSearch} className="cursor-pointer">{t('history.clearFilters')}</Button>}
                />
              )
            : (
                <EmptyState
                  icon={<History className="h-6 w-6" />}
                  title={t('history.empty')}
                  action={<Button onClick={handleBack} className="cursor-pointer">开始对话</Button>}
                />
              )
      ) : (
        // 任务卡片网格 + 分页器
        <>
          <div>
            <TaskHistoryList
              tasks={tasks}
              isLoading={isLoading}
              onRefresh={() => loadTasks(searchKeyword, favoriteOnly)}
            />
          </div>
        </>
      )}
    </div>
  )

  if (embedded) {
    return (
      <>
        <div className="page-toolbar">
          {toolbar}
        </div>
        <div className="page-content p-0">
          {content}
        </div>
      </>
    )
  }

  return (
    <PageShell
      toolbar={toolbar}
    >
      {content}

      {/* 用户日志弹窗 */}
      <UserLogsModal open={logsModalOpen} onClose={() => setLogsModalOpen(false)} />

      {/* 视频历史弹窗 */}
      <VideoHistoryModal
        open={videoHistoryModalOpen}
        onClose={() => setVideoHistoryModalOpen(false)}
      />
    </PageShell>
  )
}
