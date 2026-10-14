/**
 * ChatMessageList - 消息列表组件
 * 负责渲染消息列表和回到底部按钮
 */
'use client'

import type { IDisplayMessage, IWorkflowStep } from '@web/store/agent'
import { useAgentStore } from '@web/store/agent'
import { ArrowDown } from 'lucide-react'
import { useState } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import { ChatMessage } from '@web/components/Chat/ChatMessage'
import { FailureActions } from '@web/components/Chat/FailureActions'
import { RatingModal } from '@web/components/Chat/Rating'
import { Button } from '@web/components/ui/button'
import { StarRating } from '@web/components/ui/star-rating'
import { toast } from '@web/utils/ui/toast'

/**
 * 这条正文是不是「模型调用失败」本身（不是模型写出来的内容）。
 *
 * 模型一个字都没拿到时，服务端会把原因当正文发回来（`大模型调用失败：…。请检查 API 地址、
 * 密钥和模型名后重试。`）。它看起来和一条正常回复没有区别，而前端从前只按 status 判失败，
 * 这类失败于是既没有三个出口、任务也停在「已完成 / 运行中」（DEF-268，违反产品硬约束第 3 条）。
 *
 * @param content - 消息正文。
 * @returns 是否属于模型调用失败。
 */
function isModelCallFailureText(content: string | undefined): boolean {
  const text = (content ?? '').trim()
  if (text === '')
    return false
  return /^大模型调用失败/.test(text) || text.includes('initialize timed out')
}

export interface IChatMessageListProps {
  /** 消息列表 */
  messages: IDisplayMessage[]
  /** 工作流步骤（用于最后一条 AI 消息） */
  workflowSteps: IWorkflowStep[]
  /** 是否正在生成 */
  isGenerating: boolean
  /** 消息容器 ref */
  containerRef: React.RefObject<HTMLDivElement>
  /** 底部占位 ref */
  bottomRef: React.RefObject<HTMLDivElement>
  /** 是否显示回到底部按钮 */
  showScrollButton: boolean
  /** 滚动事件处理 */
  onScroll: () => void
  /** 点击回到底部 */
  onScrollToBottom: () => void
  /** 回到底部按钮文案 */
  scrollToBottomText: string
  /** 任务 ID */
  taskId?: string
  /** 任务评分（null 表示未评价） */
  rating?: number | null
  /** 评分保存成功回调 */
  onRatingSaved?: () => void
}

export function ChatMessageList({
  messages,
  workflowSteps,
  isGenerating,
  containerRef,
  bottomRef,
  showScrollButton,
  onScroll,
  onScrollToBottom,
  scrollToBottomText,
  taskId,
  rating,
  onRatingSaved,
}: IChatMessageListProps) {
  const { t } = useTransClient('chat')
  const [ratingOpen, setRatingOpen] = useState(false)
  const [selectedRating, setSelectedRating] = useState<number | null>(null)
  /** 收到「放弃」的失败气泡 id：放弃后这条错误不再占着位置（数据仍在任务记录里）。 */
  const [dismissedErrors, setDismissedErrors] = useState<string[]>([])
  const [failureBusy, setFailureBusy] = useState(false)

  // 过滤出用户和 AI 消息
  const filteredMessages = messages.filter(
    (message): message is IDisplayMessage & { role: 'user' | 'assistant' } =>
      message.role === 'user' || message.role === 'assistant',
  )

  // 判断是否显示评分 UI
  const hasUserMessage = filteredMessages.some(m => m.role === 'user')
  const hasAssistantMessage = filteredMessages.some(m => m.role === 'assistant')
  const isNotRated = rating === null || rating === undefined
  const showRatingUI
    = hasUserMessage && hasAssistantMessage && isNotRated && !isGenerating && taskId

  /**
   * 失败态三选择（BFS-104.4）。
   *
   * 失败原因不同，用户要的东西就不同：
   * - 断点继续：把原始那一句**接着发给同一个任务**（已跑成的步骤不会重跑）；
   * - 重新生成：**开一条新任务**，用原话重来一遍（旧任务原样留着，便于对照）；
   * - 放弃：收起这条错误气泡，不再占位置（记录仍在任务记录里）。
   *
   * 原始那一句从"这条失败气泡之前最近的用户消息"取：这是对话里唯一一处
   * 能确定用户当时到底说了什么的地方，不猜、也不用标题或摘要顶替。
   */
  const handleFailureContinue = async (previousPrompt: string, medias?: IDisplayMessage['medias']) => {
    if (previousPrompt === '' || failureBusy)
      return
    setFailureBusy(true)
    try {
      if (taskId !== undefined && taskId !== '') {
        await useAgentStore.getState().continueTask({
          taskId,
          prompt: previousPrompt,
          medias,
          t: t as unknown as (key: string) => string,
        })
      }
      else {
        await useAgentStore.getState().createTask({
          prompt: previousPrompt,
          medias,
          t: t as unknown as (key: string) => string,
        })
      }
    }
    catch {
      toast.error('继续失败，稍后再试一次')
    }
    finally {
      setFailureBusy(false)
    }
  }

  const handleFailureRegenerate = async (previousPrompt: string, medias?: IDisplayMessage['medias']) => {
    if (previousPrompt === '' || failureBusy)
      return
    setFailureBusy(true)
    try {
      await useAgentStore.getState().createTask({
        prompt: previousPrompt,
        medias,
        t: t as unknown as (key: string) => string,
      })
    }
    catch {
      toast.error('重新生成失败，稍后再试一次')
    }
    finally {
      setFailureBusy(false)
    }
  }

  // 处理星星点击
  const handleStarClick = (value: number) => {
    setSelectedRating(value)
    setRatingOpen(true)
  }

  // 处理评分保存成功
  const handleRatingSaved = () => {
    setRatingOpen(false)
    setSelectedRating(null)
    toast.success(t('rating.submitSuccess'))
    onRatingSaved?.()
  }

  return (
    <div className="flex-1 relative overflow-hidden">
      {/* 消息列表 - 外层负责滚动，内层限宽居中 */}
      <div ref={containerRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 pt-4 pb-4 flex gap-4 flex-col">
          {filteredMessages.map((message, index) => {
            // 判断是否为最后一条 assistant 消息（用于显示工作流）
            const isLastAssistant
              = message.role === 'assistant' && index === filteredMessages.length - 1

            // 失败气泡的出口：只在"确实失败了、还没被放弃"时给。
            //
            // 两条判据覆盖两类失败（DEF-268）：
            // ① status === 'error'：服务端明确把这一轮标成失败（SSE error 事件 / result.status）；
            // ② 正文本身就是"模型调用失败"这句原文——服务端曾把这种失败当**普通回复**发回来
            //    （status 是 done），用户看着一行红字、一个按钮也点不了，只能自己重发。
            const failed
              = (message.status === 'error' || isModelCallFailureText(message.content))
                && !dismissedErrors.includes(message.id)
            let errorActions: React.ReactNode
            if (failed) {
              let previous: IDisplayMessage | undefined
              for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
                if (filteredMessages[cursor].role === 'user') {
                  previous = filteredMessages[cursor]
                  break
                }
              }
              const previousPrompt = previous?.content ?? ''
              errorActions = (
                <FailureActions
                  onContinue={previousPrompt === '' ? undefined : () => void handleFailureContinue(previousPrompt, previous?.medias)}
                  onRegenerate={previousPrompt === '' ? undefined : () => void handleFailureRegenerate(previousPrompt, previous?.medias)}
                  onAbandon={() => setDismissedErrors(prev => [...prev, message.id])}
                  busy={failureBusy}
                />
              )
            }

            return (
              <ChatMessage
                key={message.id}
                id={message.id}
                role={message.role}
                content={message.content}
                medias={message.medias}
                status={message.status}
                errorMessage={message.errorMessage}
                createdAt={message.createdAt}
                steps={message.steps}
                workflowSteps={isLastAssistant && isGenerating ? workflowSteps : undefined}
                actions={message.actions}
                publishFlows={message.publishFlows}
                isGenerating={isLastAssistant && isGenerating}
                edited={message.edited}
                errorActions={errorActions}
                onEditMessage={(messageId, nextContent) => {
                  useAgentStore.getState().editUserMessage(messageId, nextContent)
                }}
              />
            )
          })}

          {/* 如果正在生成但还没有 assistant 消息，显示一个空的 AI 消息 */}
          {isGenerating && messages.every(m => m.role === 'user') && (
            <ChatMessage
              role="assistant"
              content=""
              status="streaming"
              workflowSteps={workflowSteps}
              isGenerating={true}
            />
          )}

          {/* 评分引导 UI */}
          {showRatingUI && (
            <div className="flex flex-col items-start gap-3 py-6">
              <p className="text-sm text-muted-foreground">{t('rating.feedbackPrompt')}</p>
              <StarRating onChange={handleStarClick} size="md" />
            </div>
          )}

          {/* 底部占位元素 */}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* 回到底部按钮 */}
      {showScrollButton && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <Button
            variant="secondary"
            size="sm"
            onClick={onScrollToBottom}
            className="rounded-full shadow-lg bg-background/95 backdrop-blur-sm hover:bg-background border border-border gap-1.5 px-4 transition-all hover:shadow-xl"
          >
            <ArrowDown className="w-4 h-4" />
            <span className="text-sm">{scrollToBottomText}</span>
          </Button>
        </div>
      )}

      {/* 评分弹窗 */}
      {taskId && (
        <RatingModal
          taskId={taskId}
          open={ratingOpen}
          defaultRating={selectedRating}
          onClose={() => setRatingOpen(false)}
          onSaved={handleRatingSaved}
        />
      )}
    </div>
  )
}
