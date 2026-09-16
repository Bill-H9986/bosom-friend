import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

interface AgentFollowState {
  /** 跟随模式：开启后 AI 智能体自动执行动作并跳转相应页面。 */
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  toggle: () => void
}

export const useAgentFollowStore = create<AgentFollowState>()(
  persist(
    set => ({
      enabled: true,
      setEnabled: enabled => set({ enabled }),
      toggle: () => set(state => ({ enabled: !state.enabled })),
    }),
    {
      name: 'bosom-friend-agent-follow',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
