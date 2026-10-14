/**
 * notifications store - 消息通知中心状态
 * 全局公告 / 更新日志 / 工单反馈，未读计数与已读持久化
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export interface NotificationItem {
  id: string
  /**
   * `system` = 自动检查的主动汇报（服务端 `auto-tasks.ts` 写入，id 以 `auto-` 开头）。
   * 与运营公告分开一类：公告是"产品说了什么"，system 是"你这台机器上刚发现了什么"，
   * 后者要能一眼看出来并去处理。
   */
  type: 'announcement' | 'changelog' | 'system' | 'ticket'
  title: string
  content: string
  time: string
  highlight?: boolean
}

/** 计入未读红点的通知类型：只有"需要人知悉/处理"的两类；更新日志与工单不占红点。 */
function isUnreadKind(type: NotificationItem['type']): boolean {
  return type === 'announcement' || type === 'system'
}

interface NotificationState {
  items: NotificationItem[]
  seenIds: string[]
  unreadCount: number
  setItems: (items: NotificationItem[]) => void
  markAllRead: () => void
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      items: [],
      seenIds: [],
      unreadCount: 0,
      setItems: (items) => {
        const seenIds = get().seenIds
        const unreadCount = items.filter(item => isUnreadKind(item.type) && !seenIds.includes(item.id)).length
        set({ items, unreadCount })
      },
      markAllRead: () => {
        const items = get().items
        set({
          seenIds: Array.from(new Set([
            ...get().seenIds,
            ...items.filter(item => isUnreadKind(item.type)).map(item => item.id),
          ])),
          unreadCount: 0,
        })
      },
    }),
    {
      name: 'bosom-friend-notifications',
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ seenIds: state.seenIds }),
    },
  ),
)
