/**
 * TaskPreview - 任务预览组件
 * 功能：显示最近的任务卡片列表、AI 生成素材，支持 Tab 切换和"浏览全部"跳转
 */

'use client'

import type { TaskListItem } from '@web/api/ai/ai.types'
import type { MediaItem } from '@web/api/materials/material.types'
import type { MediaPreviewItem } from '@web/components/common/MediaPreview'
import { ArrowRight, Bot, History } from 'lucide-react'
import Link from '@web/next-shims/link'
import { useParams } from '@web/next-shims/navigation'
import { startTransition, useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentApi, getAgentAssets } from '@web/api/ai/ai.api'

import { useTransClient } from '@web/app/i18n/client'
import TaskHistoryList from '@web/components/Chat/TaskHistoryList'
import { MediaPreview } from '@web/components/common/MediaPreview'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/tabs'
import { useUserStore } from '@web/store'
import { convertAssetToMediaItem } from '@web/utils/agent/asset'
import { getOssUrl } from '@web/utils/oss'
import { MediaPreviewList } from './components/MediaPreviewList'

export interface ITaskPreviewProps {
  /** 显示数量 */
  limit?: number
  /** 自定义类名 */
  className?: string
}

/** Tab 类型 */
type TabValue = 'tasks' | 'agent'

/**
 * TaskPreview - 任务预览组件
 */
export function TaskPreview({ limit = 4, className }: ITaskPreviewProps) {
  const { t } = useTransClient('chat')
  const { lng } = useParams()

  const { _hasHydrated, token } = useUserStore(
    useShallow(state => ({
      _hasHydrated: state._hasHydrated,
      token: state.token,
    })),
  )

  // 当前选中的 Tab
  const [activeTab, setActiveTab] = useState<TabValue>('tasks')

  // 任务状态
  const [taskState, setTaskState] = useState<{
    tasks: TaskListItem[]
    isLoading: boolean
  }>({
    tasks: [],
    isLoading: true,
  })

  // AI 生成素材状态
  const [agentState, setAgentState] = useState<{
    mediaList: MediaItem[]
    isLoading: boolean
  }>({
    mediaList: [],
    isLoading: true,
  })

  // 媒体预览弹窗状态
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [previewItems, setPreviewItems] = useState<MediaPreviewItem[]>([])

  /** 加载任务列表 */
  const loadTasks = useCallback(async () => {
    try {
      const result = await agentApi.getTaskList({ page: 1, pageSize: limit })
      if (result && result.code === 0 && result.data) {
        startTransition(() => {
          setTaskState({
            tasks: result.data.list || [],
            isLoading: false,
          })
        })
      }
      else {
        startTransition(() => {
          setTaskState(prev => ({ ...prev, isLoading: false }))
        })
      }
    }
    catch (error) {
      console.error('Load task list failed:', error)
      startTransition(() => {
        setTaskState(prev => ({ ...prev, isLoading: false }))
      })
    }
  }, [limit])

  /** 加载 AI 生成素材 */
  const loadAgentAssets = useCallback(async () => {
    try {
      const result = await getAgentAssets({ page: 1, pageSize: limit })
      if (result && result.data) {
        // 转换为 MediaItem 格式
        const convertedList = (result.data.list || []).map(convertAssetToMediaItem)
        startTransition(() => {
          setAgentState({
            mediaList: convertedList,
            isLoading: false,
          })
        })
      }
      else {
        startTransition(() => {
          setAgentState(prev => ({ ...prev, isLoading: false }))
        })
      }
    }
    catch (error) {
      console.error('Load agent assets failed:', error)
      startTransition(() => {
        setAgentState(prev => ({ ...prev, isLoading: false }))
      })
    }
  }, [limit])

  /** 处理 AI 生成素材点击 - 打开预览弹窗 */
  const handleAgentAssetClick = useCallback(
    (index: number) => {
      const items: MediaPreviewItem[] = agentState.mediaList.map((media) => {
        // AI 生成素材可能是视频或图片
        const isVideo = media.type === 'video'
        return {
          type: isVideo ? ('video' as const) : ('image' as const),
          src: getOssUrl(media.url),
          title: media.title,
        }
      })
      setPreviewItems(items)
      setPreviewIndex(index)
      setPreviewOpen(true)
    },
    [agentState.mediaList],
  )

  // 初始化加载
  useEffect(() => {
    if (!_hasHydrated)
      return

    if (token) {
      // 加载任务列表
      loadTasks()
      // 加载 AI 生成素材
      loadAgentAssets()
    }
    else {
      // 未登录时停止 loading
      startTransition(() => {
        setTaskState(prev => ({ ...prev, isLoading: false }))
        setAgentState(prev => ({ ...prev, isLoading: false }))
      })
    }
  }, [_hasHydrated, token, loadTasks, loadAgentAssets])

  /** 获取浏览全部链接 */
  const getViewAllLink = (tab: TabValue): string => {
    switch (tab) {
      case 'tasks':
        return '/draft-box'
      case 'agent':
        return '/agent-assets'
      default:
        return '/draft-box'
    }
  }

  // 任务 Tab：加载完成且无数据
  const tasksLoadedNoData
    = !taskState.isLoading && taskState.tasks.length === 0

  // 素材 Tab：加载完成且无数据
  const agentLoadedNoData
    = !agentState.isLoading && agentState.mediaList.length === 0

  return (
    <section className={className}>
      <div className="w-full max-w-5xl mx-auto">
        <Tabs
          value={activeTab}
          onValueChange={value => setActiveTab(value as TabValue)}
          className="w-full"
        >
          {/* Tab 标题栏 */}
          <div className="flex items-center justify-between mb-6">
            <TabsList className="h-11 p-1 bg-muted/50 rounded-lg">
              <TabsTrigger
                value="tasks"
                className="gap-2 px-4 h-9 text-sm font-medium rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm transition-all"
              >
                <History className="w-4 h-4" />
                <span className="hidden sm:inline">{t('home.recentTasks')}</span>
              </TabsTrigger>
              <TabsTrigger
                value="agent"
                className="gap-2 px-4 h-9 text-sm font-medium rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm transition-all"
              >
                <Bot className="w-4 h-4" />
                <span className="hidden sm:inline">{t('home.agentAssets')}</span>
              </TabsTrigger>
            </TabsList>

            {/* 浏览全部按钮 */}
            <Link
              href={getViewAllLink(activeTab)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors cursor-pointer group"
            >
              {t('home.viewAll')}
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>

          {/* Tab 内容区域 - 固定最小高度避免抖动 */}
          <div className="min-h-[200px]">
            {/* 最近任务 */}
            <TabsContent value="tasks" className="mt-0">
              {tasksLoadedNoData ? (
                /* 官网同款空状态：暂无媒体资源 */
                <div className="flex flex-col items-center justify-center py-16 rounded-2xl border border-dashed border-border bg-muted/20">
                  <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#8b7cf6]/10 to-[#a78bfa]/15 flex items-center justify-center mb-4">
                    <History className="w-6 h-6 text-[#a78bfa]" />
                  </div>
                  <p className="text-sm text-muted-foreground mb-1">
                    暂无任务记录
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    在顶部输入提示词，AI 将在这里展示你的创作任务
                  </p>
                </div>
              ) : (
                <TaskHistoryList
                  tasks={taskState.tasks}
                  isLoading={taskState.isLoading}
                  skeletonCount={limit}
                  onRefresh={() => loadTasks()}
                  className="grid-cols-2 md:grid-cols-4"
                />
              )}
            </TabsContent>

            {/* AI 生成素材 */}
            <TabsContent value="agent" className="mt-0">
              {agentLoadedNoData ? (
                <div className="flex flex-col items-center justify-center py-16 rounded-2xl border border-dashed border-border bg-muted/20">
                  <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#8b7cf6]/10 to-[#a78bfa]/15 flex items-center justify-center mb-4">
                    <Bot className="w-6 h-6 text-[#a78bfa]" />
                  </div>
                  <p className="text-sm text-muted-foreground mb-1">
                    暂无 AI 生成素材
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    AI 生成的图片与视频将在这里展示
                  </p>
                </div>
              ) : (
                <MediaPreviewList
                  mediaList={agentState.mediaList}
                  isLoading={agentState.isLoading}
                  skeletonCount={limit}
                  onItemClick={handleAgentAssetClick}
                />
              )}
            </TabsContent>
          </div>
        </Tabs>
      </div>

      {/* 媒体预览弹窗 */}
      <MediaPreview
        open={previewOpen}
        items={previewItems}
        initialIndex={previewIndex}
        onClose={() => setPreviewOpen(false)}
      />
    </section>
  )
}

export default TaskPreview
