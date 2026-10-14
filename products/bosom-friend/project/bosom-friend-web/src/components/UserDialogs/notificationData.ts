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
  type: 'announcement' | 'changelog' | 'system'
  title: string
  content: string
  time: string
  highlight?: boolean
}

/** 后端条目 → 前端通知项（字段一一对应，不改写内容）。 */
function toItem(item: BackendNotificationItem, type: NotificationItem['type']): NotificationItem {
  return {
    id: item.id,
    type,
    title: item.title,
    content: item.content,
    time: item.time,
    highlight: item.highlight,
  }
}

/**
 * 从后端拉取实时通知（公告 + 自动检查汇报 + 更新日志），失败回退空列表。
 *
 * 三类分开返回：界面按类型分栏显示，未读口径也只认公告与自动检查（见 store/notifications）。
 */
export async function fetchNotifications(): Promise<{
  announcements: NotificationItem[]
  changelogs: NotificationItem[]
  systems: NotificationItem[]
}> {
  try {
    const res = await fetch(`${WEB_API_BASE_URL}/notification/list`, { cache: 'no-store' })
    const body = await res.json() as { code: number; data: BackendNotificationItem[] | null; message: string }
    if (body.code === 0 && Array.isArray(body.data)) {
      const raw = body.data as BackendNotificationItem[]
      return {
        announcements: raw.filter(item => item.type === 'announcement').map(item => toItem(item, 'announcement')),
        changelogs: raw.filter(item => item.type === 'changelog').map(item => toItem(item, 'changelog')),
        systems: raw.filter(item => item.type === 'system').map(item => toItem(item, 'system')),
      }
    }
  }
  catch {
    // 后端不可用：不展示伪造通知
  }
  return { announcements: [], changelogs: [], systems: [] }
}

/** 自动任务的运行状态（服务端只读接口 `v2/auto-task/status`）。 */
export interface AutoTaskStatus {
  enabled: boolean
  intervalMinutes: number
  lastScanAt: string | null
  lastCounts: { reception: number, publishFailed: number, loginProblem: number }
  /** 最近一次自动检查自身的失败原文；没失败过时为空串。 */
  lastError: string
}

/**
 * 拉取自动任务状态。
 *
 * 接口不可用时返回 null——界面如实显示"状态暂时读不到"，不编造"刚刚检查过"。
 */
export async function fetchAutoTaskStatus(): Promise<AutoTaskStatus | null> {
  try {
    const res = await fetch(`${WEB_API_BASE_URL}/v2/auto-task/status`, { cache: 'no-store' })
    const body = await res.json() as { code: number; data: AutoTaskStatus | null }
    if (body.code === 0 && body.data)
      return body.data
  }
  catch {
    // 后端不可用：不编造运行状态
  }
  return null
}
