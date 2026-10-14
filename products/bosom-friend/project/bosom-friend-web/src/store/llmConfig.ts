/**
 * llmConfig - 全局大模型配置 store
 *
 * 自定义大模型激活后全系统生效：应用启动即加载，保存/切换即时同步，
 * 所有 AI 请求（聊天 / 创作 / 互动等）统一读取激活厂商的模型与接口参数。
 */
'use client'

import { create } from 'zustand'

const LOCAL_KEY = 'zhiyin-custom-llm'

export interface LlmChannel {
  baseUrl: string
  model: string
  hasApiKey: boolean
  apiKey?: string
}

export interface LlmProvider {
  id: string
  name: string
  enabled: boolean
  chat: LlmChannel
  image: LlmChannel
  video: LlmChannel
}

export interface LlmGlobalStatus {
  providers: LlmProvider[]
  activeProviderId: string | null
  enabled: boolean
}

interface LlmConfigState {
  status: LlmGlobalStatus | null
  loaded: boolean
  load: () => Promise<void>
  sync: (status: LlmGlobalStatus) => void
  getActive: () => LlmProvider | null
  getChatModel: () => string
  getChatEndpoint: () => { baseUrl: string, apiKey: string, model: string } | null
}

export const useLlmConfigStore = create<LlmConfigState>((set, get) => ({
  status: null,
  loaded: false,
  load: async () => {
    try {
      if (typeof window === 'undefined' || !window.ipcRenderer) return
      const raw = await window.ipcRenderer.getStoreValue(LOCAL_KEY)
      if (raw && typeof raw === 'object') {
        set({ status: raw as LlmGlobalStatus })
      }
    }
    catch {
      // 本地配置读取失败时忽略，使用默认Bosom Friend内置智能
    }
    set({ loaded: true })
  },
  sync: (status) => set({ status }),
  getActive: () => {
    const s = get().status
    if (!s || !s.enabled || !s.providers?.length) return null
    return s.providers.find(p => p.id === s.activeProviderId && p.enabled) || null
  },
  getChatModel: () => {
    const active = get().getActive()
    return active?.chat?.model?.trim() || ''
  },
  getChatEndpoint: () => {
    const active = get().getActive()
    if (!active?.chat?.baseUrl?.trim()) return null
    return {
      baseUrl: active.chat.baseUrl.trim(),
      apiKey: active.chat.apiKey || '',
      model: active.chat.model.trim() || '',
    }
  },
}))
