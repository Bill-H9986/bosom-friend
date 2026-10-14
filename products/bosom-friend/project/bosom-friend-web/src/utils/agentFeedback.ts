/**
 * 智能体前端反馈工具：把每一步操作结果（可选页面截图）写入当前会话，
 * 并落盘到后端任务消息，保证刷新后仍可从「我的任务」回看。
 */
'use client'

import type { IDisplayMessage } from '@web/store/agent'
import { useAgentStore } from '@web/store/agent'
import http from '@web/utils/request'

export async function appendAgentFeedback(content: string, dataUrl?: string): Promise<void> {
  const taskId = useAgentStore.getState().currentTaskId
  if (!taskId)
    return
  const message: IDisplayMessage = {
    id: `agent-feedback-${Date.now()}`,
    role: 'assistant',
    content,
    ...(dataUrl ? { medias: [{ type: 'image' as const, url: dataUrl }] } : {}),
    status: 'done',
    createdAt: Date.now(),
  }
  useAgentStore.getState().appendMessage(message, taskId)
  if (!dataUrl)
    return
  try {
    await http.post(`agent/tasks/${encodeURIComponent(taskId)}/messages`, {
      content,
      medias: [{ type: 'image', url: dataUrl, name: 'AI 操作截图' }],
    }, true)
  }
  catch {
    // 本地消息已可见；后端落盘失败不打断用户操作
  }
}

export async function captureCurrentPage(): Promise<string> {
  const html2canvas = (await import('html2canvas-pro')).default
  const target = document.querySelector('#main-content') || document.body
  const canvas = await html2canvas(target as HTMLElement, {
    backgroundColor: '#ffffff',
    scale: 1,
    useCORS: true,
  })
  return canvas.toDataURL('image/png')
}
