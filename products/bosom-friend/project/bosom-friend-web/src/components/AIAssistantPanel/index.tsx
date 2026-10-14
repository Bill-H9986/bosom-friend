/**
 * AIAssistantPanel - 右侧 AI 助手侧边栏
 * 与左侧边栏样式完全一致：Logo 区 + 可折叠 + 底部输入
 */
'use client'

import type { IDisplayMessage } from '@web/store/agent/agent.types'
import type { IWorkflowStep } from '@web/store/agent'
import { Bot, CheckCircle2, Eye, EyeOff, Loader2, MessageSquarePlus, Sparkles, Wrench } from 'lucide-react'
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
import { executeAgentNavigateAction, executeAgentPublishAction, executeAgentSaveDraftAction, executeAgentUpdateDraftAction } from '@web/components/Chat/ActionCard/executePublishAction'
import { runReceptionAutoOnce } from '@web/utils/receptionAutoRunner'
import http from '@web/utils/request'
import { cn } from '@web/utils/className'
import { toolDisplayName } from '@web/components/Chat/utils/toolLabels'
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


/** 一条消息里的全部过程步骤（工具调用/结果按发生顺序）。 */
function stepsOf(message: IDisplayMessage): IWorkflowStep[] {
  return (message.steps ?? []).flatMap(step => step.workflowSteps ?? [])
}

/**
 * 过程栏：助手"在做什么"。
 *
 * 为什么侧边栏也要有它：右侧助手是用户看着它干活的地方，而这条链路原先只显示正文——
 * 模型在查账号、查素材的那十几秒里，界面是一片空白转圈（用户口径："要么失败，
 * 要么一下蹦出答案"）。工具名走共享标签表（"查平台账号"而不是 bosom_platform_list_accounts）。
 */
function StepTrail({ steps }: { steps: IWorkflowStep[] }) {
  const [expanded, setExpanded] = useState(false)
  if (steps.length === 0)
    return null
  const done = steps.filter(step => step.result !== undefined).length
  const active = steps.find(step => step.isActive)
  const visible = expanded ? steps : steps.slice(-(active === undefined ? 3 : 4))
  return (
    <div className="mb-1.5 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5" data-testid="ai-assistant-steps">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {active !== undefined ? <Loader2 className="h-3 w-3 animate-spin text-primary" /> : <CheckCircle2 className="h-3 w-3 text-success" />}
        <span className="font-medium text-foreground/80">
          {active !== undefined ? toolDisplayName(active.toolName || '') : '已完成 ' + String(done) + ' 步'}
        </span>
        {steps.length > visible.length && (
          <button type="button" className="ml-auto cursor-pointer underline-offset-2 hover:underline" onClick={() => setExpanded(true)}>
            共 {steps.length} 步
          </button>
        )}
        {expanded && steps.length > 4 && (
          <button type="button" className="ml-auto cursor-pointer underline-offset-2 hover:underline" onClick={() => setExpanded(false)}>
            收起
          </button>
        )}
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {visible.map(step => (
          <li key={step.id} className="flex items-start gap-1.5 text-[11px] leading-5">
            {step.isActive
              ? <Loader2 className="mt-1 h-2.5 w-2.5 shrink-0 animate-spin text-primary" />
              : step.result !== undefined
                ? <CheckCircle2 className="mt-1 h-2.5 w-2.5 shrink-0 text-success" />
                : <Wrench className="mt-1 h-2.5 w-2.5 shrink-0 text-muted-foreground/70" />}
            <span className={cn('min-w-0 flex-1 truncate', step.isActive ? 'text-primary' : 'text-muted-foreground')}>
              {toolDisplayName(step.toolName || '')}
              {step.result !== undefined ? '：' + step.result.replace(/\s+/g, ' ').slice(0, 60) : '…'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
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
  const inputWrapRef = useRef<HTMLDivElement>(null)
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
    // 主区域正停在某条任务的详情页时，"新对话"必须把它一起带走：
    // 否则左侧页面显示着旧任务、右侧助手已经是一条空白新对话，两个面板对同一份数据各说各话
    // （用户口径的"侧边栏与我的任务不同步"）。停在其他功能页时不跳转——助手是全局面板，
    // 点一下"新对话"就把用户从创作页拽走是另一种更糟的体验。
    // 桌面壳的路由不带语言前缀（带前缀会落到首页）：这是同一个 hash 路由表里的 /chat/:taskId。
    if (typeof window !== 'undefined' && /^#\/chat\/task-/.test(window.location.hash)) {
      router.push('/chat/new')
    }
  }, [stopTask, resetAgent, router, lng])

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
    if (!followEnabled) {
      return
    }
    const actionMessage = [...messages].reverse().find(message => message.role === 'assistant' && message.actions?.length)
    if (actionMessage && actionMessage.actions) {
    }
    // 跟随模式可自动执行的动作：导航类 + 发布 + 出片 / 存草稿 / 改写草稿。
    // 后三类 2026-09-30 起改由**前端执行**（内核只登记参数，不再直连后端），
    // 所以这里必须一起认，否则动作卡渲染出来却没人执行。
    const AUTO_EXECUTABLE_ACTIONS = new Set(['navigateToPublish', 'saveDraft', 'updateDraft'])
    const navigateAction = actionMessage?.actions?.find(action =>
      // 服务端已经把这张卡标成"已执行"的（内核建草稿工具自己落了库并回传真实 id）不再自动执行：
      // 再执行一次会写出**第二条草稿**，用户看到的就是"我只说了一次，草稿箱多了两条"（DEF-270）。
      action.state !== 'executed'
      && (action.type.startsWith('navigateTo') || AUTO_EXECUTABLE_ACTIONS.has(action.type)))
    // 只认到动作就够了：助手面板是**临时会话**，在内容创作页里 currentTaskId 常常是空的
    // （实测日志：MessageUtils No taskId set）。此前把 taskId 当成硬前提，
    // 结果"出片申请"这类动作卡渲染出来了却永远没人执行。去重键在没有 taskId 时退化为动作本身。
    if (!navigateAction)
      return
    const key = `${currentTaskId ?? 'adhoc'}:${JSON.stringify(navigateAction)}`
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
      let started = false
      if (navigateAction.type === 'navigateToPublish') {
        started = executeAgentPublishAction(navigateAction, router)
      }
      else if (navigateAction.type === 'saveDraft') {
        void executeAgentSaveDraftAction(navigateAction, currentTaskId ?? undefined).then((ok) => {
          if (ok) toast.success('已存进草稿箱')
          else toast.error('存草稿失败：内容为空或接口报错')
        })
        started = true
      }
      else if (navigateAction.type === 'updateDraft') {
        void executeAgentUpdateDraftAction(navigateAction, currentTaskId ?? undefined).then((ok) => {
          if (ok) toast.success('已写回草稿')
          else toast.error('改写失败：缺少草稿 id 或内容为空')
        })
        started = true
      }
      else {
        started = executeAgentNavigateAction(navigateAction, router)
      }
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

  /**
   * 展开后把光标送进输入框：插话是"想起来就说一句"，多要求一次点击
   * 就把这条通道的意义削掉一半。收起时需要等面板过渡（420ms）走完再聚焦，
   * 否则元素还没进入可聚焦状态。聚焦失败不影响任何功能，静默即可。
   */
  useEffect(() => {
    if (collapsed)
      return undefined
    const timer = window.setTimeout(() => {
      inputWrapRef.current?.querySelector('textarea')?.focus()
    }, 220)
    return () => window.clearTimeout(timer)
  }, [collapsed])

  /**
   * M4（ADR-005 呈现层改造方案 v1.0）：收起态**不占任何宽度**。
   *
   * 此前收起后仍是一条 68px 的常驻窄条——首屏对话区右边永远缺一块，
   * 页面上并列着两条输入框，用户不知道该用哪条（方案第 8.2 节 R2 风险）。
   * 现在「插话」是一个明确的入口按钮：要用它才占位置，不用就完全让路给主对话。
   */
  if (collapsed) {
    return (
      <>
        {/* 移动端入口：跳转完整对话页（移动端没有侧栏，插话走整页） */}
        <Link
          href={`/${lng}/chat/new`}
          className="fixed bottom-6 right-6 z-[90] flex h-12 items-center gap-2 rounded-full bg-gradient-to-r from-brand-purple to-brand-cyan px-4 text-sm font-semibold text-white shadow-lg shadow-brand-purple/30 md:hidden"
          data-testid="ai-assistant-mobile-entry"
        >
          <Bot className="h-5 w-5" />
          AI 助手
        </Link>

        {/* 桌面端：右下角插话入口，点开才展开右侧面板 */}
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="展开 AI 插话通道"
          data-testid="ai-assistant-expand-btn"
          className="fixed bottom-6 right-6 z-[80] hidden cursor-pointer items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-sm backdrop-blur transition-all duration-200 ease-apple hover:border-brand-cyan/50 hover:bg-brand-cyan/10 md:flex"
        >
          <Sparkles size={16} className="text-brand-cyan" />
          有话插一句
        </button>
      </>
    )
  }

  return (
    <>
      {/* 右侧 AI 插话面板（展开态）：与左侧边栏同款 */}
      <aside
        ref={panelRef}
        className={cn(
          'group sticky right-0 top-0 hidden h-screen flex-col border-l sidebar-divider-l border-sidebar-border bg-sidebar p-3 pt-12 transition-all duration-[420ms] ease-apple md:flex',
          collapsed ? 'w-[68px] min-w-[68px]' : 'w-[240px] min-w-[240px]',
        )}
        data-testid="ai-assistant-sidebar"
      >
        {/* Logo 区域 - 与左侧 LogoSection 同一组件，侧边=右侧（结构/样式逐字一致） */}
        <LogoSection collapsed={false} onToggle={() => setCollapsed(true)} side="right" />

        {/* 跟随模式：开启开关后，AI 智能体自动执行动作并跳转对应页面 */}
        <div className="mb-3 flex items-center justify-between gap-2 px-1">
          <span className="text-xs text-muted-foreground">跟随模式</span>
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
                                <StepTrail steps={stepsOf(message)} />
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
          <div ref={inputWrapRef} className="flex min-h-0 flex-shrink-0 flex-col pt-3 max-h-[190px]">
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
