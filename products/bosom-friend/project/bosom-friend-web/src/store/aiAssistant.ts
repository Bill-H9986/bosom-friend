/**
 * aiAssistant store - 右侧「插话通道」的收放状态
 *
 * 【2026-10-12 恢复旧排版】默认**展开**：这是 09-30 起一直在用的样子，也是
 * ADR-005（M4「降级为可收起的插话通道」）之前的行为。产品负责人反馈
 * 「以前的都有、整个项目的功能页排版被打乱」，右侧这块常驻面板正是旧版有、
 * 改造后默认消失的那一块；S 级前端监考也把「右侧输入框可打字」当作唯一
 * 前端输入通道，默认收起会让它整条跑不起来。
 *
 * 用户仍然可以点「收起」把面板让给主区（收放选择照常被记住）；变的只是初始值。
 *
 * 持久化键带 `v3`：默认值从「收起」翻回「展开」属于语义变更，
 * 沿用旧键会让老用户机器上留着的那份 `collapsed: true` 把新默认值顶掉
 * （表现为"改了没生效"）。换键 = 一次性回到新默认，之后用户的收放选择照常被记住。
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
      name: 'bosom-friend-ai-assistant-v3',
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ collapsed: state.collapsed }),
    },
  ),
)
