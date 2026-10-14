/**
 * TaskInstance - SSE 消息处理模块
 * 处理来自服务端的 SSE 事件
 */

import type {
  IActionCard,
  IDisplayMessage,
  IMediaItem,
  IPublishFlowData,
  ISSEMessage,
  IWorkflowStep,
} from '../agent.types'
import type { ISSECallbacks, ISSEHandlerContext } from './task-instance.types'
import {
  addMarkdownMessage,
  updateMessageContent,
  updateMessageContentWithMedias,
  updateMessageWithActionsAndPublishFlows,
} from './message.handler'
import {
  addWorkflowStep,
  handleTextDelta,
  handleToolCallComplete,
  handleToolResult,
  saveCurrentStepToMessage,
  startNewStep,
  updateLastWorkflowStep,
} from './workflow.handler'

// ============ SSE 消息处理主入口 ============

/**
 * 处理 SSE 消息
 * 所有消息都会写入到当前任务数据中
 */
export function handleSSEMessage(
  ctx: ISSEHandlerContext,
  msg: ISSEMessage,
  callbacks?: ISSECallbacks,
): void {
  // 处理 init 消息 - 迁移到真实 taskId
  if (msg.type === 'init' && msg.taskId) {
    ctx.migrateToRealTaskId(msg.taskId)
    ctx.setStreamingText('')
    callbacks?.onTaskIdReady?.(msg.taskId)
    return
  }

  // 心跳消息，忽略
  if (msg.type === 'keep_alive') {
    return
  }

  // 处理 stream_event 消息
  if (msg.type === 'stream_event') {
    handleStreamEvent(ctx, msg)
    return
  }

  // 处理 assistant 消息（工具调用完成）
  if (msg.type === 'assistant' && msg.message) {
    handleAssistantMessage(ctx, msg)
    return
  }

  // 处理 user 消息（工具结果）
  if (msg.type === 'user' && msg.message) {
    handleUserMessage(ctx, msg)
    return
  }

  // 处理 text 消息
  if (msg.type === 'text' && msg.message) {
    addMarkdownMessage(ctx, msg.message as string)
    return
  }

  // 处理 result 消息
  if (msg.type === 'result') {
    handleResultMessage(ctx, msg)
    return
  }

  // 处理 error 消息
  if (msg.type === 'error') {
    handleErrorMessage(ctx, msg, callbacks)
    return
  }

  // 处理 done 消息
  if (msg.type === 'done') {
    // 先保存当前步骤（如果有内容），防止消息丢失
    const streamingText = ctx.getStreamingText()
    const currentStepWorkflow = ctx.getCurrentStepWorkflow()
    if (streamingText.trim() || currentStepWorkflow.length > 0) {
      saveCurrentStepToMessage(ctx)
    }

    ctx.markMessageDone()
    callbacks?.onComplete?.()
  }
}

// ============ 内部处理函数 ============

/**
 * 处理 stream_event 消息
 */
function handleStreamEvent(ctx: ISSEHandlerContext, msg: ISSEMessage): void {
  const event = extractEvent(msg)
  if (!event)
    return

  // message_start - 开始新步骤
  // 每个新的"消息"（包含文本或工具调用）都会有一个 message_start 事件
  // 只有当有文字内容时才开始新步骤，连续的MCP调用（没有文字消息间隔）应该属于同一个步骤
  if (event.type === 'message_start') {
    // 只有当有文字内容时才开始新步骤
    // 连续的MCP调用（没有文字消息间隔）应该属于同一个步骤
    const streamingText = ctx.getStreamingText()

    if (streamingText.trim()) {
      startNewStep(ctx)
    }
    else if (ctx.getCurrentStepIndex() < 0) {
      // 第一次 message_start，初始化 stepIndex 为 0
      ctx.incrementCurrentStepIndex()
    }

    return
  }

  // content_block_start (tool_use)
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const toolName = event.content_block.name || 'Unknown Tool'
    const toolId = event.content_block.id || `tool-${Date.now()}`

    const newStep: IWorkflowStep = {
      id: toolId,
      type: 'tool_call',
      toolName,
      content: '',
      isActive: true,
      timestamp: Date.now(),
    }
    addWorkflowStep(ctx, newStep)
    return
  }

  // text_delta - 追加文本，并检查是否需要分割步骤
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    const text = event.delta.text
    if (!text)
      return

    // 如果当前步骤已经有工作流但没有文字，开始新步骤
    // 这样开头的 MCP 调用会在一个步骤，文字开始后是新步骤
    const currentStepWorkflow = ctx.getCurrentStepWorkflow()
    const streamingText = ctx.getStreamingText()
    if (currentStepWorkflow.length > 0 && !streamingText.trim()) {
      startNewStep(ctx)
    }

    ctx.appendStreamingText(text)
    handleTextDelta(ctx)
    return
  }

  // input_json_delta
  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
    const partialJson = event.delta.partial_json
    if (partialJson) {
      updateLastWorkflowStep(ctx, step => ({
        ...step,
        content: (step.content || '') + partialJson,
      }))
    }
  }
}

/**
 * 处理 assistant 消息
 */
function handleAssistantMessage(ctx: ISSEHandlerContext, msg: ISSEMessage): void {
  const assistantMsg = msg.message as any
  if (assistantMsg?.message?.content && Array.isArray(assistantMsg.message.content)) {
    assistantMsg.message.content.forEach((item: any) => {
      if (item.type === 'tool_use') {
        const toolName = item.name || 'Unknown Tool'
        const toolInput = item.input ? JSON.stringify(item.input, null, 2) : ''
        handleToolCallComplete(ctx, toolName, toolInput)
      }
    })
  }
}

/**
 * 处理 user 消息（工具结果）
 */
function handleUserMessage(ctx: ISSEHandlerContext, msg: ISSEMessage): void {
  const userMsg = msg.message as any
  const contentArray = userMsg?.content || userMsg?.message?.content
  if (contentArray && Array.isArray(contentArray)) {
    contentArray.forEach((item: any) => {
      if (item.type === 'tool_result') {
        let resultText = ''
        if (Array.isArray(item.content)) {
          item.content.forEach((rc: any) => {
            if (rc.type === 'text') {
              resultText = rc.text || ''
            }
          })
        }
        else if (typeof item.content === 'string') {
          resultText = item.content
        }
        if (resultText) {
          handleToolResult(ctx, resultText)
        }
      }
    })
  }
}

/**
 * 处理 result 消息
 * 支持 result 为数组的情况（多平台发布）
 */
function handleResultMessage(ctx: ISSEHandlerContext, msg: ISSEMessage): void {
  const messageData = msg.data || msg.message
  if (!messageData)
    return

  // 获取 result 数组：优先从 messageData.result 获取，否则将 messageData 视为单个结果
  const resultArray: any[] = Array.isArray(messageData.result) ? messageData.result : [messageData]

  const actions: IActionCard[] = []
  const publishFlows: IPublishFlowData[] = []

  // 优先使用流式传输累积的完整内容
  // 如果 streamingText 为空（被 startNewStep 清空），content 保持为空
  // 更新函数会保留消息原有的 content，避免被 description 覆盖截断
  const streamingText = ctx.getStreamingText()
  const content = (typeof messageData.content === 'string' && messageData.content.trim())
    ? messageData.content.trim()
    : streamingText.trim()

  // 遍历 result 数组处理每个结果
  for (const data of resultArray) {
    // 如果有 flowId，创建发布流程数据
    if (data.flowId) {
      publishFlows.push({
        flowId: data.flowId,
        platform: data.platform,
        initialData: {
          title: data.title,
          description: data.description,
          medias: data.medias,
        },
      })
    }

    // 如果有 action，创建 action 卡片
    if (data.action) {
      actions.push({
        type: data.action,
        platform: data.platform,
        accountId: data.accountId,
        title: data.title,
        description: data.description,
        medias: data.medias as IMediaItem[],
        tags: data.tags || data.topics,
        flowId: data.flowId,
        // 出片 / 改草稿要带的参数（2026-09-30）：少了这几个字段，前端执行器就拿不到
        // topic / draftId，会直接判"没执行"——实测表现正是"动作卡渲染出来但点了没反应"。
        // 历史消息那条路在 convertMessages 里也有同一组映射，两处要一起改。
        draftId: data.draftId,
        topic: data.topic,
        producer: data.producer,
        targetSeconds: data.targetSeconds,
        aspectRatio: data.aspectRatio,
        // 授权标记必须原样带下去：两条转换路径各映射一次字段，漏了这行，
        // 组件里 `action.explicitPublishIntent` 恒为 undefined，自动发布闸门永远拒绝
        // —— 表现为「跟随模式开着也不自动发」（2026-10-09 DEF-240-IMPLEMENT-4 实测）。
        explicitPublishIntent: data.explicitPublishIntent,
        // 动作工单号必须原样带下去：少了它，动作卡与任务上的回填台账（task.actionResults）
        // 对不上号，界面只能显示「未回填」（DEF-248）。历史消息那条路在 convertMessages
        // 里有同一组映射，两处一起改。
        requestId: data.requestId,
        // 执行态也必须原样带下去（DEF-270）：内核建草稿工具自己落了库时，服务端直接把卡
        // 标成 'executed'——少了这一行，卡片又变成"可点、未回填"，而事情其实已经做完了。
        state: data.state,
        _isRealtime: true,
      })
    }
  }

  // 更新消息
  if (publishFlows.length > 0 || actions.length > 0) {
    updateMessageWithActionsAndPublishFlows(ctx, content, actions, publishFlows)
  }
  else {
    // 检查第一个结果是否有媒体
    const firstData = resultArray[0]
    if (firstData?.medias && firstData.medias.length > 0) {
      updateMessageContentWithMedias(ctx, content, firstData.medias)
    }
    else if (content) {
      // DEF-268：服务端在 result 事件里带 status:'error' 时，这条消息要按失败渲染，
      // 前端才会给出「断点继续 / 重新生成 / 放弃」（产品硬约束第 3 条）。
      updateMessageContent(ctx, content, undefined, messageData.status === 'error')
    }
  }
}

/**
 * 处理 error 消息
 */
async function handleErrorMessage(
  ctx: ISSEHandlerContext,
  msg: ISSEMessage,
  callbacks?: ISSECallbacks,
): Promise<void> {
  const errorCode = (msg as any).code
  const errorMessage
    = typeof msg.message === 'string' ? msg.message : (msg.message as any)?.message || 'Unknown error'

  // 任务不存在（18100）/ 会话无法恢复（18109）：不再渲染失败气泡，
  // 交由调用方自动转为新会话，保证对话不中断。
  if (errorCode === 18100 || errorCode === 18109) {
    callbacks?.onSessionExpired?.()
    return
  }

  if (errorCode === 12001) {
    // 先保存当前步骤内容，防止正在流式传输的文字消息丢失
    const streamingText = ctx.getStreamingText()
    const currentStepWorkflow = ctx.getCurrentStepWorkflow()
    if (streamingText.trim() || currentStepWorkflow.length > 0) {
      saveCurrentStepToMessage(ctx)
    }

    // 积分不足：在聊天中显示卡片，不跳转
    const insufficientMsg: IDisplayMessage = {
      id: `assistant-insufficient-${Date.now()}`,
      role: 'assistant',
      content: '',
      status: 'done',
      createdAt: Date.now(),
      actions: [
        {
          type: 'insufficientCredits',
        },
      ],
    }
    ctx.addMessage(insufficientMsg)
  }
  else {
    // 其他错误：创建错误消息
    if (errorMessage) {
      const errorMsg: IDisplayMessage = {
        id: `assistant-error-${Date.now()}`,
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: Date.now(),
        actions: [
          {
            type: 'errorOnly',
            title: '生成失败',
            description: errorMessage,
          },
        ],
      }
      ctx.addMessage(errorMsg)
    }
  }

  // 更新任务状态
  setTimeout(() => {
    ctx.setIsGenerating(false)
  }, 100)
  ctx.setProgress(0)

  callbacks?.onError?.(new Error(errorMessage))
}

// ============ 工具函数 ============

/**
 * 从 SSE 消息中提取 event 对象
 */
function extractEvent(msg: ISSEMessage): any {
  if ((msg as any).event) {
    return (msg as any).event
  }
  if (msg.message && typeof msg.message === 'object') {
    return (msg.message as any).event
  }
  return null
}
