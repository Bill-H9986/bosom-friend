/**
 * 全自动接待前端状态。
 *
 * 开关只控制“前端智能体自动读取待办并调用真实平台发送”，后端仍保持只读采集；
 * 状态保存在本地，重启后保留下一次可继续的自动接待策略。
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

interface ReceptionAutoState {
  /** 全自动接待开关。 */
  enabled: boolean
  /** 正在执行一条待办。 */
  running: boolean
  /** 最近一次处理完成的待办 id。 */
  lastProcessedId?: string
  /** 最近一次处理完成时间。 */
  lastProcessedAt?: string
  /** 最近一次处理错误。 */
  lastError?: string
  setEnabled: (enabled: boolean) => void
  setRunning: (running: boolean) => void
  markProcessed: (id: string) => void
  markError: (error: string) => void
}

export const useReceptionAutoStore = create<ReceptionAutoState>()(
  persist(
    set => ({
      enabled: true,
      running: false,
      setEnabled: enabled => set({ enabled }),
      setRunning: running => set({ running }),
      markProcessed: id => set({
        running: false,
        lastProcessedId: id,
        lastProcessedAt: new Date().toISOString(),
        lastError: undefined,
      }),
      markError: error => set({ running: false, lastError: error }),
    }),
    {
      name: 'bosom-friend-reception-auto',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
