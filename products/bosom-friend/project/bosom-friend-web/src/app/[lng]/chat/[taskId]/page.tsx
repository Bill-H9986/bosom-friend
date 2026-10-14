/**
 * 对话详情页 - Chat Detail
 * 功能：支持实时模式（从 HomeChat 跳转）和历史模式（刷新或从任务列表进入）
 * 工作流状态实时显示在对应消息上
 */
'use client'

import { useParams, useRouter } from '@web/next-shims/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { agentApi } from '@web/api/ai/ai.api'
import { useTransClient } from '@web/app/i18n/client'
import { ActionResultsProvider } from '@web/components/Chat/ActionCard/ActionResultsContext'
import { ChatInput } from '@web/components/Chat/ChatInput'
import EditTitleModal from '@web/components/common/EditTitleModal'
import { PublishDetailModal } from '@web/components/Plugin/PublishDetailModal'
import { useMediaUpload } from '@web/hooks'
import { useAgentStore } from '@web/store/agent'
import { isRecoveredTaskId } from '@web/store/agent/sessionRecovery'
import { usePluginStore } from '@web/store/plugin'
import { toast } from '@web/utils/ui/toast'

// 页面私有组件
import { ChatHeader, ChatLoadingSkeleton, ChatMessageList, ToolTracePanel } from './components'
import { OneSentenceEquivalents } from '@web/app/[lng]/tasks-history/components/OneSentenceEquivalents'
// 页面私有 hooks
import { useChatState, useScrollControl } from './hooks'

export default function ChatDetailPage() {
  const { t } = useTransClient('chat')
  const { t: tHome } = useTransClient('home')
  const router = useRouter()
  const params = useParams()
  const taskId = params.taskId as string
  const lng = params.lng as string

  // 桌面壳用 hash 路由 `/chat/:taskId`（路由表里没有 [lng] 段），此时 params.lng 是 undefined。
  // 把 undefined 直接拼进路径会得到 `/undefined/chat/<id>`——没有这条路由，兜底的通配
  // `{ path: '*' }` 再把它重定向回 `/`，用户看到的就是"发送后一闪、最终回到首屏"。
  // Web 端（Next.js 的 `/[lng]/chat/[taskId]`）仍然带 lng，路径保持原样。
  const lngPrefix = lng ? `/${lng}` : ''
  // 没有待处理任务时回落的首页地址，同样不能拼出 `/undefined`。
  const homePath = lngPrefix || '/'

  // Store 方法
  const { createTask, continueTask, stopTask, setActionContext, consumePendingTask }
    = useAgentStore()

  // 聊天状态管理
  const {
    task,
    displayMessages,
    workflowSteps,
    isLoading,
    isGenerating,
    progress,
    isActiveTask,
    setLocalIsGenerating,
    updateTaskTitle,
  } = useChatState({
    taskId,
    t: t as (key: string) => string,
  })

  // 中断状态 - 用于强制隐藏工作流步骤
  const [isInterrupted, setIsInterrupted] = useState(false)

  // 本地评分状态 - 用于评分成功后立即更新 UI
  const [localRating, setLocalRating] = useState<number | null | undefined>(undefined)

  // 收藏状态（乐观更新）
  const [isFavorited, setIsFavorited] = useState(false)

  // 编辑标题状态
  const [editTitleOpen, setEditTitleOpen] = useState(false)

  // 发布详情弹框状态
  const [publishDetailVisible, setPublishDetailVisible] = useState(false)
  const [currentPublishTaskId, setCurrentPublishTaskId] = useState<string | undefined>(undefined)
  // 跟踪用户是否手动关闭了弹窗
  const [userClosedModal, setUserClosedModal] = useState(false)

  // 滚动控制
  const {
    containerRef,
    bottomRef,
    isNearBottom,
    showScrollButton,
    scrollToBottom,
    handleScroll,
    onContentReady,
  } = useScrollControl()

  // 输入状态
  const [inputValue, setInputValue] = useState('')

  // 媒体上传
  const {
    medias,
    setMedias,
    isUploading,
    handleMediasChange,
    handleMediaRemove,
    handleMediaUpdate,
    clearMedias,
  } = useMediaUpload({
    onError: () => toast.error(t('media.uploadFailed')),
  })

  // 监听发布任务创建
  const publishTasks = usePluginStore(state => state.publishTasks)

  // 不把对话标题写进页面标题：桌面壳会把 document.title 带到**窗口标题与任务栏**上，
  // 于是用户第一句问的内容（任务标题就是它的前 30 字）会一直挂在别的程序旁边——
  // 内容私事外泄，而且那个位置该是产品名。对话标题在页面里本来就看得到，不需要再往窗口上搬。

  // 从 task 初始化收藏状态
  useEffect(() => {
    if (task) {
      setIsFavorited(!!task.favoritedAt)
    }
  }, [task])

  // 监听发布任务创建，显示发布详情弹框
  useEffect(() => {
    if (publishTasks.length > 0) {
      // 获取最新的发布任务（通常是刚创建的）
      const latestTask = publishTasks[0]
      if (latestTask && !publishDetailVisible && !userClosedModal) {
        setCurrentPublishTaskId(latestTask.id)
        setPublishDetailVisible(true)
        // 重置用户关闭状态，因为现在有新任务了
        setUserClosedModal(false)
      }
    }
  }, [publishTasks, publishDetailVisible, userClosedModal])

  /**
   * 设置 Action 上下文（用于处理任务结果的 action）
   */
  useEffect(() => {
    setActionContext({
      router,
      lng,
      t: tHome,
    })
  }, [router, lng, tHome, setActionContext])

  /**
   * 处理新任务：当 taskId 为 "new" 时，从 store 获取待处理任务并发起请求
   *
   * 一次 `new` 转场只处理一次。原来的写法没有这道闸门，而依赖里的 `router` 是
   * `next-shims/navigation` 每次渲染新造的对象，于是 createTask 内部任何一次 set
   * 引发的重渲染都会让本 effect 重跑；第二次 `consumePendingTask()` 已是 null，
   * 代码就把它当成"没有待处理任务"，把正在跑的任务丢在后台、把用户送回首页
   * （实测 URL 轨迹：`#/chat/new` → `#/undefined` → `#/`）。
   */
  const newTaskHandledRef = useRef(false)

  useEffect(() => {
    if (taskId !== 'new') {
      // 离开 new 之后解锁：从详情页返回首屏再次发起时，同一条闸门还要能用。
      newTaskHandledRef.current = false
      return
    }
    if (newTaskHandledRef.current)
      return
    newTaskHandledRef.current = true

    const pendingTask = consumePendingTask()
    if (!pendingTask) {
      // 确实没有待处理任务（例如直接打开 `/chat/new`），回首页
      router.replace(homePath)
      return
    }

    // 发起任务创建
    const startTask = async () => {
      setIsInterrupted(false)
      setLocalIsGenerating(true)
      try {
        await createTask({
          prompt: pendingTask.prompt,
          medias: pendingTask.medias,
          t: t as (key: string) => string,
          onTaskIdReady: (newTaskId) => {
            // 使用 replace 替换 URL，不添加历史记录
            router.replace(`${lngPrefix}/chat/${newTaskId}`)
          },
        })
      }
      catch (error: any) {
        console.error('[ChatPage] Create task failed:', error)
        toast.error(error.message || t('message.error'))
        // 出错时返回首页
        router.replace(homePath)
      }
    }

    startTask()
  }, [taskId, lngPrefix, homePath, router, consumePendingTask, createTask, t, setLocalIsGenerating])

  /**
   * 首次加载完成后，强制滚动到底部
   */
  useEffect(() => {
    // 当数据加载完成且有消息时，确保滚动到底部
    if (!isLoading && displayMessages.length > 0) {
      onContentReady()
    }
  }, [isLoading, displayMessages.length, onContentReady])

  /**
   * 智能滚动：用户在底部附近时自动滚动
   */
  useEffect(() => {
    if (isNearBottom) {
      scrollToBottom()
    }
  }, [displayMessages, workflowSteps, isNearBottom, scrollToBottom])

  /**
   * 发送消息（继续对话）
   */
  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || isGenerating)
      return

    const currentPrompt = inputValue
    const currentMedias = [...medias]

    // 清空输入
    setInputValue('')
    clearMedias()
    // 重置中断状态，开始新任务
    setIsInterrupted(false)
    setLocalIsGenerating(true)

    // 强制滚动到底部
    scrollToBottom(true)

    try {
      await continueTask({
        prompt: currentPrompt,
        medias: currentMedias,
        t: t as (key: string) => string,
        taskId,
        onTaskIdReady: (newTaskId) => {
          // 后端会话恢复失败并新建任务时跟随新任务，避免旧路线继续读写旧任务。
          if (isRecoveredTaskId(taskId, newTaskId)) {
            router.replace(`${lngPrefix}/chat/${newTaskId}`)
          }
        },
      })
    }
    catch (error: any) {
      console.error('Continue task failed:', error)
      toast.error(error.message || t('message.error'))
      // 恢复输入
      setInputValue(inputValue)
      setMedias(currentMedias)
    }
    finally {
      setLocalIsGenerating(false)
    }
  }, [
    inputValue,
    medias,
    isGenerating,
    taskId,
    t,
    continueTask,
    clearMedias,
    setMedias,
    scrollToBottom,
    setLocalIsGenerating,
  ])

  /**
   * 停止生成
   */
  const handleStop = useCallback(async () => {
    try {
      // 调用后端 API 中断任务
      await agentApi.abortTask(taskId)
      // 显示停止成功的提示
      toast.info(tHome('aiGeneration.taskStopped'))
    }
    catch (error: any) {
      console.error('[ChatPage] Failed to abort task:', error)
      toast.error(t('message.error'))
    }
    finally {
      // 无论 API 调用是否成功，都停止本地状态
      // 立即设置中断状态，强制隐藏工作流步骤
      setIsInterrupted(true)
      // 立即设置本地生成状态为 false，确保 UI 立即响应
      setLocalIsGenerating(false)
      stopTask()
    }
  }, [taskId, t, tHome, stopTask, setLocalIsGenerating])

  /**
   * 返回首页
   */
  const handleBack = useCallback(() => {
    // 中断当前正在进行的任务，防止竞态条件
    if (isGenerating) {
      stopTask()
    }

    // If there's a previous entry in the history stack, go back.
    // Otherwise, navigate to the root homepage.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back()
    }
    else {
      router.push('/')
    }
  }, [router, isGenerating, stopTask])

  /**
   * 收藏切换 - 乐观更新
   */
  const handleFavoriteToggle = useCallback(async () => {
    const newValue = !isFavorited
    setIsFavorited(newValue) // 先更新 UI

    try {
      if (newValue) {
        await agentApi.favoriteTask(taskId)
      }
      else {
        await agentApi.unfavoriteTask(taskId)
      }
    }
    catch {
      setIsFavorited(!newValue) // 失败回滚
      toast.error(t('message.error'))
    }
  }, [isFavorited, taskId, t])

  /**
   * 保存标题 - 乐观更新
   */
  const handleSaveTitle = useCallback(
    async (newTitle: string) => {
      const result = await agentApi.updateTaskTitle(taskId, newTitle)
      if (result && result.code === 0) {
        // 更新本地 task 状态，触发页面标题和 header 标题更新
        updateTaskTitle(newTitle)
        toast.success(t('task.titleUpdated'))
      }
      else {
        throw new Error('Save failed')
      }
    },
    [taskId, t, updateTaskTitle],
  )

  // 加载中且当前没有任何可渲染消息时显示骨架屏。
  // 原判据是「非活跃任务」，于是从右侧 AI 面板发起的新会话（活跃、但 store 里还没有
  // 这个 taskId 的消息）在详情页既不出骨架也不出内容，只剩 header 与输入框（空白页）。
  if (isLoading && displayMessages.length === 0) {
    return <ChatLoadingSkeleton />
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部导航 */}
      <ChatHeader
        title={task?.title}
        defaultTitle={t('task.newChat')}
        isGenerating={isGenerating}
        progress={progress}
        thinkingText={t('message.thinking')}
        taskId={taskId}
        agentRole={task?.agentRole ?? null}
        rating={task?.rating ?? null}
        isFavorited={isFavorited}
        onFavoriteToggle={handleFavoriteToggle}
        onEditTitle={() => setEditTitleOpen(true)}
        onBack={handleBack}
      />

      {/* 消息列表：一条可渲染消息都没有时也要给出明确状态，绝不让中间留成空白 */}
      {displayMessages.length === 0
        ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              {t('detail.waitingResponse')}
            </div>
          )
        : (
            <ActionResultsProvider results={task === null ? null : (task.actionResults ?? [])}>
              <ChatMessageList
                messages={displayMessages}
                workflowSteps={isInterrupted ? [] : workflowSteps}
                isGenerating={isGenerating}
                containerRef={containerRef}
                bottomRef={bottomRef}
                showScrollButton={showScrollButton}
                onScroll={handleScroll}
                onScrollToBottom={() => scrollToBottom(true)}
                scrollToBottomText={t('detail.scrollToBottom')}
                taskId={taskId}
                rating={localRating !== undefined ? localRating : (task?.rating ?? null)}
                onRatingSaved={() => setLocalRating(1)}
              />
            </ActionResultsProvider>
          )}

      {/* 工具轨迹：这一轮调了哪些工具（只读、无按钮） */}
      {task !== null && <ToolTracePanel trace={task.toolTrace} />}
      <OneSentenceEquivalents page="chat-detail" />
      {/* 底部输入区域 - 限宽居中 */}
      <div className="p-4 shrink-0">
        <div className="max-w-6xl mx-auto">
          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            medias={medias}
            onMediasChange={handleMediasChange}
            onMediaRemove={handleMediaRemove}
            onMediaUpdate={handleMediaUpdate}
            isGenerating={isGenerating}
            isUploading={isUploading}
            placeholder={t('detail.continuePlaceholder')}
            mode="compact"
          />
        </div>
      </div>

      {/* 发布状态弹框已按要求移除（2026-09-29）：它只显示「平台发布失败」四个字，
          既说不出真实原因、又打断用户；发布过程与结果一律在聊天卡片里如实呈现。 */}

      {/* 编辑标题弹窗 */}
      <EditTitleModal
        open={editTitleOpen}
        onOpenChange={setEditTitleOpen}
        currentTitle={task?.title || ''}
        onSave={handleSaveTitle}
      />
    </div>
  )
}
