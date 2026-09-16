/**
 * aiAssistant store - 右侧 AI 助手侧边栏状态
 * 与左侧边栏独立收放（宽度类保持一致）
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

interface AiAssistantState {
  collapsed: boolean
  setCollapsed: (collapsed: boolean) => void
  toggleCollapsed: () => void
  /** APP 控制（Agent）唤起面板时预填的问题 */
  pendingPrompt: string
  setPendingPrompt: (prompt: string) => void
}

export const useAiAssistantStore = create<AiAssistantState>()(
  persist(
    set => ({
      collapsed: false,
      setCollapsed: collapsed => set({ collapsed }),
      toggleCollapsed: () => set(state => ({ collapsed: !state.collapsed })),
      pendingPrompt: '',
      setPendingPrompt: prompt => set({ pendingPrompt: prompt }),
    }),
    {
      name: 'bosom-friend-ai-assistant',
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ collapsed: state.collapsed }),
    },
  ),
)
