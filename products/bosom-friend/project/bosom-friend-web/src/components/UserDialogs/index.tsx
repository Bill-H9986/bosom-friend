/**
 * UserDialogs - 用户菜单弹窗（联系我们 / 消息通知）
 */
'use client'

import {
  Bell,
  CheckCheck,
  FileText,
  Inbox,
  LifeBuoy,
  Mail,
  Megaphone,
  MessageCircle,
  Send,
  Settings,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/components/ui/dialog'
import { Button } from '@web/components/ui/button'
import { Input } from '@web/components/ui/input'
import { Textarea } from '@web/components/ui/textarea'
import { CONTACT } from '@web/constant'
import type { NotificationItem } from '@web/store/notifications'
import { useNotificationStore } from '@web/store/notifications'
import { useSettingsModalStore } from '@web/store/settingsModal'
import { cn } from '@web/utils/className'
import { toast } from '@web/utils/ui/toast'
import { FALLBACK_NOTIFICATIONS, fetchNotifications } from './notificationData'
import { submitFeedback } from '@web/api/contact'

interface TicketItem {
  id: string
  title: string
  content: string
  status: '待处理' | '已处理'
  time: string
}

const TICKETS_KEY = 'bosom-friend-tickets'

function loadTickets(): TicketItem[] {
  if (typeof window === 'undefined')
    return []
  try {
    const raw = window.localStorage.getItem(TICKETS_KEY)
    return raw ? JSON.parse(raw) as TicketItem[] : []
  }
  catch {
    return []
  }
}

function saveTickets(tickets: TicketItem[]) {
  window.localStorage.setItem(TICKETS_KEY, JSON.stringify(tickets))
}

/**
 * 联系我们弹窗（含工单反馈）
 */
export function ContactDialog({ open, onOpenChange }: { open: boolean, onOpenChange: (open: boolean) => void }) {
  const [tickets, setTickets] = useState<TicketItem[]>([])
  const [ticketTitle, setTicketTitle] = useState('')
  const [ticketContent, setTicketContent] = useState('')
  const [ticketContact, setTicketContact] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open)
      setTickets(loadTickets())
  }, [open])

  const submitTicket = async () => {
    if (!ticketTitle.trim() || !ticketContent.trim()) {
      toast.error('请填写反馈标题和内容')
      return
    }
    setSubmitting(true)
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    const newTicket: TicketItem = {
      id: `ticket-${Date.now()}`,
      title: ticketTitle.trim(),
      content: ticketContent.trim(),
      status: '待处理',
      time,
    }
    const next = [newTicket, ...loadTickets()]
    saveTickets(next)
    setTickets(next)
    try {
      // 真实发送到客服邮箱（后端 SMTP），失败不阻断本地记录
      const result = await submitFeedback({
        title: ticketTitle.trim(),
        content: ticketContent.trim(),
        contact: ticketContact.trim() || undefined,
      })
      toast.success(result?.sent === false ? '反馈已记录，邮件通道待配置' : '反馈已提交并发送至客服邮箱，我们会尽快处理')
    }
    catch {
      toast.success('反馈已记录，我们会尽快处理')
    }
    finally {
      setTicketTitle('')
      setTicketContent('')
      setTicketContact('')
      setSubmitting(false)
    }
  }

  /** 标记工单为已处理 */
  const markTicketDone = (id: string) => {
    const next = loadTickets().map(ticket =>
      ticket.id === id ? { ...ticket, status: '已处理' as const } : ticket,
    )
    saveTickets(next)
    setTickets(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>联系我们</DialogTitle>
          <DialogDescription>使用过程中有任何问题，欢迎通过以下方式与我们联系。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <a
            href={`mailto:${CONTACT}`}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-border/60 p-3 transition-all duration-300 ease-apple-out hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-lg hover:shadow-primary/10"
          >
            <Mail className="h-5 w-5 shrink-0 text-brand-cyan" />
            <div className="min-w-0">
              <p className="text-sm font-medium">客服邮箱 / 工单反馈</p>
              <p className="truncate text-sm text-muted-foreground">{CONTACT}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">点击直接发送邮件，或使用下方表单提交反馈</p>
            </div>
          </a>
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <MessageCircle className="h-5 w-5 shrink-0 text-brand-cyan" />
            <div className="min-w-0">
              <p className="text-sm font-medium">微信公众号</p>
              <p className="text-sm text-muted-foreground">敬请等待！</p>
            </div>
          </div>
        </div>

        {/* 工单反馈 */}
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <LifeBuoy className="h-4 w-4 text-brand-cyan" />
            工单反馈（提交后自动发送至客服邮箱）
          </p>
          <Input
            value={ticketTitle}
            onChange={e => setTicketTitle(e.target.value)}
            placeholder="反馈标题，例如：发布功能建议"
          />
          <Textarea
            value={ticketContent}
            onChange={e => setTicketContent(e.target.value)}
            placeholder="详细描述你遇到的问题或建议..."
            rows={3}
          />
          <Input
            value={ticketContact}
            onChange={e => setTicketContact(e.target.value)}
            placeholder="联系方式（选填，方便我们回复你）"
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={submitTicket} disabled={submitting} className="cursor-pointer">
              <Send className="mr-1 h-3.5 w-3.5" />
              {submitting ? '提交中…' : '提交反馈'}
            </Button>
          </div>

          {tickets.length === 0
            ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
                  <Inbox className="h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm">暂无工单，遇到问题随时提交反馈</p>
                </div>
              )
            : (
                <div className="flex max-h-52 flex-col overflow-y-auto">
                  {tickets.map(ticket => (
                    <div key={ticket.id} className="flex flex-col gap-1 border-b border-border py-2.5 last:border-b-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{ticket.title}</span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {ticket.status === '待处理' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 cursor-pointer px-1.5 text-xs text-muted-foreground hover:text-green-600"
                              onClick={() => markTicketDone(ticket.id)}
                            >
                              标记已处理
                            </Button>
                          )}
                          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs', ticket.status === '已处理' ? 'bg-green-500/10 text-green-600' : 'bg-amber-500/10 text-amber-600')}>
                            {ticket.status}
                          </span>
                        </div>
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">{ticket.content}</p>
                      <span className="text-xs text-muted-foreground">{ticket.time}</span>
                    </div>
                  ))}
                </div>
              )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 消息通知弹窗
 * 全局公告 / 更新日志
 */
export function NotificationDialog({ open, onOpenChange }: { open: boolean, onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<'announcement' | 'changelog'>('announcement')
  const [announcements, setAnnouncements] = useState<NotificationItem[]>(
    FALLBACK_NOTIFICATIONS.filter(item => item.type === 'announcement'),
  )
  const [changelogs, setChangelogs] = useState<NotificationItem[]>(
    FALLBACK_NOTIFICATIONS.filter(item => item.type === 'changelog'),
  )
  const { setItems, markAllRead } = useNotificationStore()
  const openSettings = useSettingsModalStore(state => state.openSettings)

  // 打开时从后端拉取实时通知（动态真实时间），并标记已读
  useEffect(() => {
    if (!open)
      return
    let cancelled = false
    fetchNotifications().then(({ announcements: ann, changelogs: log }) => {
      if (cancelled)
        return
      setAnnouncements(ann)
      setChangelogs(log)
      setItems(ann)
    })
    markAllRead()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            消息通知
          </DialogTitle>
          <DialogDescription>全局公告与更新日志</DialogDescription>
        </DialogHeader>

        {/* 右上角操作 */}
        <div className="absolute right-4 top-4 flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8 cursor-pointer" onClick={markAllRead} title="全部已读">
            <CheckCheck className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 cursor-pointer"
            title="设置"
            onClick={() => {
              onOpenChange(false)
              openSettings()
            }}
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 cursor-pointer" onClick={() => onOpenChange(false)} title="关闭">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 固定窗口尺寸：切换菜单不改变大小 */}
        <div className="flex h-[440px] overflow-hidden rounded-lg border">
          {/* 左侧菜单 */}
          <div className="flex w-36 shrink-0 flex-col border-r bg-muted/30 p-2 md:w-40">
            {([
              ['announcement', <Megaphone key="a" className="h-4 w-4" />, '全局公告'],
              ['changelog', <FileText key="c" className="h-4 w-4" />, '更新日志'],
            ] as const).map(([value, icon, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={cn(
                  'btn btn-ghost btn-md w-full justify-start rounded-md',
                  tab === value
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground',
                )}
              >
                <span className="text-brand-cyan">{icon}</span>
                {label}
              </button>
            ))}
          </div>

          {/* 右侧内容 */}
          <div className="h-full flex-1 overflow-y-auto">
            {tab === 'announcement' && (
              <div className="flex flex-col">
                {announcements.map(item => (
                  <div key={item.id} className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('text-sm font-medium', item.highlight ? 'text-brand-cyan' : 'text-foreground')}>
                        {item.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{item.time}</span>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">{item.content}</p>
                  </div>
                ))}
              </div>
            )}

            {tab === 'changelog' && (
              <div className="flex flex-col">
                {changelogs.map(item => (
                  <div key={item.id} className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{item.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{item.time}</span>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">{item.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
