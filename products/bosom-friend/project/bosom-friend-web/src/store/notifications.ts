/**
 * notifications store - 消息通知中心状态
 * 全局公告 / 更新日志 / 工单反馈，未读计数与已读持久化
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export interface NotificationItem {
  id: string
  type: 'announcement' | 'changelog' | 'ticket'
  title: string
  content: string
  time: string
  highlight?: boolean
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
        const unreadCount = items.filter(item => item.type === 'announcement' && !seenIds.includes(item.id)).length
        set({ items, unreadCount })
      },
      markAllRead: () => {
        const items = get().items
        set({
          seenIds: Array.from(new Set([
            ...get().seenIds,
            ...items.filter(item => item.type === 'announcement').map(item => item.id),
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
