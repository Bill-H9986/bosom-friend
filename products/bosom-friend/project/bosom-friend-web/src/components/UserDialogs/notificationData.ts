/**
 * notificationData - 通知中心数据
 * 实时数据：从后端 /notification/list 拉取；接口不可用时只返回空列表，
 * 绝不用本地静态公告冒充实时通知。
 */
import type { NotificationItem } from '@web/store/notifications'
import { WEB_API_BASE_URL } from '@web/config/api'

/** 仅保留空数组兼容旧引用，不再伪造任何公告。 */
export const FALLBACK_NOTIFICATIONS: NotificationItem[] = []

interface BackendNotificationItem {
  id: string
  type: 'announcement' | 'changelog'
  title: string
  content: string
  time: string
  highlight?: boolean
}

/** 从后端拉取实时通知（公告 + 更新日志），失败回退本地兜底。 */
export async function fetchNotifications(): Promise<{
  announcements: NotificationItem[]
  changelogs: NotificationItem[]
}> {
  try {
    const res = await fetch(`${WEB_API_BASE_URL}/notification/list`, { cache: 'no-store' })
    const body = await res.json() as { code: number; data: BackendNotificationItem[] | null; message: string }
    if (body.code === 0 && Array.isArray(body.data)) {
      const raw = body.data as BackendNotificationItem[]
      return {
        announcements: raw.filter(item => item.type === 'announcement').map(item => ({
          id: item.id,
          type: 'announcement',
          title: item.title,
          content: item.content,
          time: item.time,
          highlight: item.highlight,
        })),
        changelogs: raw.filter(item => item.type === 'changelog').map(item => ({
          id: item.id,
          type: 'changelog',
          title: item.title,
          content: item.content,
          time: item.time,
          highlight: item.highlight,
        })),
      }
    }
  }
  catch {
    // 后端不可用：不展示伪造通知
  }
  return { announcements: [], changelogs: [] }
}
