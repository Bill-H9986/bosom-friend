/**
 * AIAssistantPanel - 右侧 AI 助手侧边栏
 * 与左侧边栏样式完全一致：Logo 区 + 可折叠 + 底部输入
 */
'use client'

import type { IDisplayMessage } from '@web/store/agent/agent.types'
import { Bot, Eye, EyeOff, Loader2, MessageSquarePlus, Sparkles } from 'lucide-react'
import Link from '@web/next-shims/link'
import { useParams, useRouter } from '@web/next-shims/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { directTrans } from '@web/app/i18n/client'
import { ChatInput } from '@web/components/Chat/ChatInput'
import { LogoSection } from '@web/app/layout/LayoutSidebar/components'
import { Button } from '@web/components/ui/button'
import { Switch } from '@web/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { useMediaUpload } from '@web/hooks/useMediaUpload'
import { useAiAssistantStore } from '@web/store/aiAssistant'
import { agentApi } from '@web/api/ai/ai.api'
import { useAgentStore } from '@web/store/agent'
import { useAgentFollowStore } from '@web/store/agentFollow'
import { useReceptionAutoStore } from '@web/store/receptionAuto'
import { ActionCard } from '@web/components/Chat/ActionCard'
import { executeAgentPublishAction, executeAgentNavigateAction } from '@web/components/Chat/ActionCard/executePublishAction'
import { runReceptionAutoOnce } from '@web/utils/receptionAutoRunner'
import http from '@web/utils/request'
import { cn } from '@web/utils/className'
import { getOssUrl } from '@web/utils/oss'
import { toast } from '@web/utils/ui/toast'
import { appendAgentFeedback, captureCurrentPage } from '@web/utils/agentFeedback'

/** 跟随模式下「已执行过」的动作键，存 sessionStorage 以便刷新后不重复执行。 */
const EXECUTED_ACTIONS_KEY = 'bosom-friend:agent-executed-actions'

const QUICK_PROMPTS = [
  '帮我写一条抖音爆款文案',
  '为一款新品生成小红书种草笔记',
  '帮我总结今天的热点并给出选题',
]

function messageText(message: IDisplayMessage): string {
  if (message.steps?.length) {
    return message.steps
      .map(step => step.content || '')
      .filter(Boolean)
      .join('\n\n')
  }
  return message.content || ''
}

/** 助手回复的 Markdown 渲染样式：加粗/列表/标题正常显示，不再露出原始符号 */
const assistantMarkdownComponents: Components = {
  h1: ({ children }) => <p className="my-1.5 text-base font-semibold text-foreground">{children}</p>,
  h2: ({ children }) => <p className="my-1.5 text-sm font-semibold text-foreground">{children}</p>,
  h3: ({ children }) => <p className="my-1 text-sm font-semibold text-foreground">{children}</p>,
  p: ({ children }) => <p className="my-1 leading-6">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
  li: ({ children }) => <li className="leading-6">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-2 border-border" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand-cyan underline-offset-2 hover:underline"
      onClick={event => event.stopPropagation()}
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => (
    <code
      className={cn(
        'rounded bg-black/5 px-1 py-0.5 text-xs',
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-x-auto rounded-lg bg-black/5 p-2 text-xs leading-5">{children}</pre>
  ),
}

export function AIAssistantPanel() {
  const params = useParams<{ lng?: string }>()
  const lng = params?.lng || 'zh-CN'
  const router = useRouter()
  const followEnabled = useAgentFollowStore(state => state.enabled)
  const setFollowEnabled = useAgentFollowStore(state => state.setEnabled)
  const receptionAutoEnabled = useReceptionAutoStore(state => state.enabled)
  const setReceptionRunning = useReceptionAutoStore(state => state.setRunning)
  const markReceptionProcessed = useReceptionAutoStore(state => state.markProcessed)
  const markReceptionError = useReceptionAutoStore(state => state.markError)
  // 独立收放：与左侧边栏互不影响（宽度样式完全一致）
  const collapsed = useAiAssistantStore(state => state.collapsed)
  const setCollapsed = useAiAssistantStore(state => state.setCollapsed)
  const pendingPrompt = useAiAssistantStore(state => state.pendingPrompt)
  const setPendingPrompt = useAiAssistantStore(state => state.setPendingPrompt)

  const currentTaskId = useAgentStore(state => state.currentTaskId)
  const taskMessages = useAgentStore(state => state.taskMessages)
  const createTask = useAgentStore(state => state.createTask)
  const continueTask = useAgentStore(state => state.continueTask)
  const stopTask = useAgentStore(state => state.stopTask)
  const resetAgent = useAgentStore(state => state.reset)

  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [inputMaxHeight, setInputMaxHeight] = useState(180)

  // 媒体上传（图片/视频/文档）：粘贴、拖拽、选择器均可用
  const { medias, isUploading, handleMediasChange, handleMediaRemove, clearMedias } = useMediaUpload()

  const taskData = currentTaskId ? taskMessages[currentTaskId] : undefined
  const messages = taskData?.messages || []
  const streamingText = taskData?.streamingText || ''
  const isGenerating = taskData?.isGenerating || false

  const translate = useCallback((key: string) => directTrans('chat', key), [])

  const appendAssistantSnapshot = useCallback(async (caption: string) => {
    try {
      const dataUrl = await captureCurrentPage()
      await appendAgentFeedback(caption, dataUrl)
    }
    catch (error) {
      console.error('[AgentSnapshot] 截图失败:', error)
      await appendAgentFeedback(`${caption}（截图失败：${error instanceof Error ? error.message : String(error)}）`)
    }
  }, [])

  const sendText = useCallback(async (rawText: string) => {
    const text = rawText.trim()
    if (!text || isGenerating)
      return

    try {
      if (currentTaskId && messages.length > 0) {
        await continueTask({
          taskId: currentTaskId,
          prompt: text,
          medias,
          t: translate,
        })
      }
      else {
        await createTask({
          prompt: text,
          medias,
          t: translate,
        })
      }
      clearMedias()
    }
    catch (error) {
      console.error('AI assistant send failed:', error)
      void http.post('ai/logs', {
        kind: 'ai_assistant_error',
        detail: '右侧AI助手发送失败：' + (error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)),
      }, true)
      toast.error('发送失败，请重试')
    }
  }, [isGenerating, currentTaskId, messages.length, medias, continueTask, createTask, translate, clearMedias])

  // 0 号铁律：APP 控制语音指令 = 填入面板并自动“发送”，
  // 由 APP Agent 通过界面/草稿箱/发布通道逐步执行，每一步都落在 APP 自己的记录里。
  useEffect(() => {
    if (!pendingPrompt)
      return
    setPendingPrompt('')
    setCollapsed(false)
    void sendText(pendingPrompt)
  }, [pendingPrompt, setPendingPrompt, setCollapsed, sendText])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text)
      return
    setInput('')
    sendText(text)
  }, [input, sendText])

  /**
   * 停止生成：先请服务端中断这一次生成（否则服务端会继续跑完并把任务落成"已完成"），
   * 再断开本地流。
   */
  const handleStop = useCallback(() => {
    if (currentTaskId)
      void agentApi.abortTask(currentTaskId).catch(() => {})
    stopTask()
  }, [currentTaskId, stopTask])

  const handleNewChat = useCallback(() => {
    stopTask()
    resetAgent()
    setInput('')
  }, [stopTask, resetAgent])

  // 自动滚动到底部
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages.length, streamingText])

  // AI 智能体前端执行器：发布意图完成后自动点击“去发布”动作卡，后续由
  // 发布弹窗自动选账号、自动提交、自动跳转数据中心同步，全程只在前端 DOM 操作。
  const autoExecutedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!followEnabled)
      return
    const actionMessage = [...messages].reverse().find(message => message.role === 'assistant' && message.actions?.length)
    const navigateAction = actionMessage?.actions?.find(action => action.type.startsWith('navigateTo'))
    if (!navigateAction || !currentTaskId)
      return
    const key = `${currentTaskId}:${JSON.stringify(navigateAction)}`
    if (autoExecutedKeyRef.current === key)
      return
    // 已执行过的动作要跨刷新记住：只按内存去重的话，每次刷新页面都会把同一个动作
    // 再执行一遍并追加一条截图记录，操作一次却留下 N 条「已执行」，
    // AC-017-2「截图与操作一一对应」当场失效（实测刷新一次从 1 条变 2 条）。
    let executed: string[] = []
    try {
      const raw = sessionStorage.getItem(EXECUTED_ACTIONS_KEY)
      const parsed: unknown = raw === null ? [] : JSON.parse(raw)
      executed = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    }
    catch {
      // sessionStorage 不可用（隐私模式/被禁用）时退化为仅内存去重，不影响本次会话内的行为。
      executed = []
    }
    if (executed.includes(key))
      return
    autoExecutedKeyRef.current = key
    const timer = window.setTimeout(() => {
      const started = navigateAction.type === 'navigateToPublish'
        ? executeAgentPublishAction(navigateAction, router)
        : executeAgentNavigateAction(navigateAction, router)
      if (!started)
        return
      executed.push(key)
      try {
        sessionStorage.setItem(EXECUTED_ACTIONS_KEY, JSON.stringify(executed.slice(-50)))
      }
      catch {
        // 写不进去只影响跨刷新去重，本次会话仍由 autoExecutedKeyRef 拦住重复执行。
      }
      void appendAssistantSnapshot(`AI 智能体已执行「${navigateAction.type}」，以下为当前页面截图。`)
    }, 400)
  }, [currentTaskId, followEnabled, messages, router, appendAssistantSnapshot])

  // 7×24 全自动接待执行器：跟随模式下由前端智能体读取待办、生成建议并调用平台发送。
  useEffect(() => {
    if (!receptionAutoEnabled)
      return
    let stopped = false
    const tick = async () => {
      if (stopped)
        return
      setReceptionRunning(true)
      try {
        const result = await runReceptionAutoOnce()
        if (result.processedId) {
          if (result.ok)
            markReceptionProcessed(result.processedId)
          else if (result.error)
            markReceptionError(result.error)
        }
      }
      catch (error) {
        markReceptionError(error instanceof Error ? error.message : String(error))
      }
      finally {
        if (!stopped)
          setReceptionRunning(false)
      }
    }
    const initial = window.setTimeout(() => void tick(), 5000)
    const timer = window.setInterval(() => void tick(), 20_000)
    return () => {
      stopped = true
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [receptionAutoEnabled, setReceptionRunning, markReceptionProcessed, markReceptionError])

  // 输入框高度与右侧面板联动：随内容增高，但最多使用约 38% 的可用高度，
  // 避免挤压任务记录/消息区；窗口或面板尺寸变化时重新计算。
  useEffect(() => {
    const panel = panelRef.current
    if (!panel)
      return

    const updateInputMaxHeight = () => {
      // 面板空间宝贵：输入框增高上限收紧（96~180px），避免撑满面板
      setInputMaxHeight(Math.max(96, Math.min(180, Math.floor(panel.clientHeight * 0.2))))
    }
    updateInputMaxHeight()

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateInputMaxHeight)
    observer?.observe(panel)
    window.addEventListener('resize', updateInputMaxHeight)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateInputMaxHeight)
    }
  }, [])

  return (
    <>
      {/* 移动端入口：跳转完整对话页 */}
      <Link
        href={`/${lng}/chat/new`}
        className="fixed bottom-6 right-6 z-[90] flex h-12 items-center gap-2 rounded-full bg-gradient-to-r from-brand-purple to-brand-cyan px-4 text-sm font-semibold text-white shadow-lg shadow-brand-purple/30 md:hidden"
        data-testid="ai-assistant-mobile-entry"
      >
        <Bot className="h-5 w-5" />
        AI 助手
      </Link>

      {/* 右侧 AI 助手侧边栏 - 与左侧边栏同款 */}
      <aside
        ref={panelRef}
        className={cn(
          'group sticky right-0 top-0 hidden h-screen flex-col border-l sidebar-divider-l border-sidebar-border bg-sidebar p-3 pt-12 transition-all duration-[420ms] ease-apple md:flex',
          collapsed ? 'w-[68px] min-w-[68px]' : 'w-[240px] min-w-[240px]',
        )}
        data-testid="ai-assistant-sidebar"
      >
        {/* Logo 区域 - 与左侧 LogoSection 同一组件，侧边=右侧（结构/样式逐字一致） */}
        <LogoSection collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} side="right" />

        {/* 跟随模式：开启开关后，AI 智能体自动执行动作并跳转对应页面 */}
        <div className="mb-3 flex items-center justify-between gap-2 px-1">
          <span className={cn('text-xs text-muted-foreground', collapsed && 'sr-only')}>跟随模式</span>
          <div className="flex items-center gap-1.5">
            {!collapsed && (
              <span className="flex items-center gap-1 text-xs text-foreground/70">
                {followEnabled ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                {followEnabled ? '跟随中' : '已关闭'}
              </span>
            )}
            <Switch
              checked={followEnabled}
              onCheckedChange={setFollowEnabled}
              aria-label="跟随模式"
              title="开启后 AI 智能体操作期间自动执行动作并跳转对应页面"
            />
          </div>
        </div>

        {/* 新对话按钮 */}
        {!collapsed && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewChat}
            className="mb-3 w-full cursor-pointer justify-start"
          >
            <MessageSquarePlus className="mr-1 h-4 w-4 text-brand-cyan" />
            新对话
          </Button>
        )}

        {/* 可滚动消息区 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
          {collapsed ? (
            <div className="flex h-full items-center justify-center">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-brand-cyan/50"><Sparkles size={20} /></span>
                  </TooltipTrigger>
                  <TooltipContent side="left"><p>展开 AI 助手对话</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          ) : messages.length === 0 && !isGenerating
            ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-cyan/10 text-brand-cyan">
                    <Sparkles className="h-6 w-6" />
                  </span>
                  <p className="text-sm font-medium text-foreground">有什么我可以帮你？</p>
                  <p className="text-xs text-muted-foreground">内容创作、热点选题、互动回复都可以问我</p>
                  <div className="mt-1 flex flex-col gap-2">
                    {QUICK_PROMPTS.map(prompt => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => sendText(prompt)}
                        className="btn btn-sm btn-outline rounded-full border-border/70 hover:border-brand-cyan hover:text-brand-cyan"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )
            : (
                <div className="flex flex-col gap-3 pr-1">
                  {messages.map(message => (
                    <div
                      key={message.id}
                      className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
                    >
                      <div
                        className={cn(
                          'max-w-[88%] rounded-2xl px-3 py-2 text-sm',
                          message.role === 'user'
                            ? 'whitespace-pre-wrap bg-gradient-to-r from-brand-purple to-brand-cyan leading-6 text-white'
                            : 'bg-muted text-foreground',
                        )}
                      >
                        {message.role === 'user'
                          ? messageText(message)
                          : (
                              <>
                                <ReactMarkdown components={assistantMarkdownComponents}>
                                  {messageText(message)}
                                </ReactMarkdown>
                                {message.actions?.map(action => (
                                  <ActionCard
                                    key={`${message.id}-${action.type}-${action.title || ''}`}
                                    action={action}
                                  />
                                ))}
                              </>
                            )}
                        {message.medias?.filter(media => media.type === 'image').map((media, index) => (
                          <img
                            key={`${message.id}-img-${index}`}
                            src={getOssUrl(media.url)}
                            alt=""
                            className="mt-2 max-h-40 w-full rounded-lg object-cover"
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  {isGenerating && (
                    <div className="flex justify-start">
                      <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl bg-muted px-3 py-2 text-sm leading-6 text-foreground">
                        {streamingText || <Loader2 className="h-4 w-4 animate-spin" />}
                      </div>
                    </div>
                  )}
                </div>
              )}
        </div>

        {/* 底部输入区 - 固定 */}
        {!collapsed && (
          <div className="flex min-h-0 flex-shrink-0 flex-col pt-3 max-h-[190px]">
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              onStop={handleStop}
              isGenerating={isGenerating}
              mode="compact"
              maxHeight={inputMaxHeight}
              placeholder="输入你的需求，AI 帮你搞定内容创作、选题、回复..."
              autoFocus
              medias={medias}
              onMediasChange={handleMediasChange}
              onMediaRemove={handleMediaRemove}
              isUploading={isUploading}
            />
          </div>
        )}
      </aside>
    </>
  )
}
