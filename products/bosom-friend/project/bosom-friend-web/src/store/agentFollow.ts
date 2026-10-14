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
      // 默认**关闭**：跟随模式会自动执行「去发布」动作卡（对外、不可撤销）。
      // 2026-10-09 事故：默认开启 + 缺少执行闸门，使一次普通提问触发了真实发布尝试（DEF-240）。
      // 已有持久化偏好（localStorage 的 bosom-friend-agent-follow）不受默认值影响，仍按用户原设置。
      enabled: false,
      setEnabled: enabled => set({ enabled }),
      toggle: () => set(state => ({ enabled: !state.enabled })),
    }),
    {
      name: 'bosom-friend-agent-follow',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
