/**
 * Bosom Friend AI 助手 · 统一指令契约
 *
 * 前端与 zhiyin 内核的交互统一走类型化指令，避免 ad-hoc CustomEvent 载荷漂移。
 * 当前指令：open-chat（唤起右侧 AI 助手面板并预填消息，后续可扩展 run-workflow 等意图）。
 */
export const ZHINYIN_OPEN_CHAT_EVENT = 'zhiyin:open-ai-chat' as const

export interface ZhiyinOpenChatCommand {
  /** 预填到输入框的消息（可为空，仅唤起面板） */
  message: string
}

/** 唤起 AI 助手面板并预填消息（供任意模块调用） */
export function dispatchOpenAiChat(message: string): void {
  if (typeof window === 'undefined')
    return
  const command: ZhiyinOpenChatCommand = { message: message?.trim() || '' }
  window.dispatchEvent(new CustomEvent<ZhiyinOpenChatCommand>(ZHINYIN_OPEN_CHAT_EVENT, {
    detail: command,
  }))
}

/** 解析助手指令事件：载荷不合法时返回 null（接收侧防御） */
export function parseOpenAiChatEvent(event: Event): ZhiyinOpenChatCommand | null {
  const detail = (event as CustomEvent<ZhiyinOpenChatCommand | undefined>).detail
  if (!detail || typeof detail !== 'object' || typeof detail.message !== 'string')
    return null
  return { message: detail.message.trim() }
}

