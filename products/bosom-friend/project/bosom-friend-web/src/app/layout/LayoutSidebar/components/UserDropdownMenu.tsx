/**
 * UserDropdownMenu - 用户头像下拉菜单组件
 * 面向普通用户精简：仅保留 联系我们 / 消息通知 / 设置 / 退出登录
 * 支持展开/折叠两种状态
 */

'use client'

import type { SidebarCommonProps } from '../types'
import type { SettingsTab } from '@web/store/settingsModal'
import { Bell, LogOut, Mail, Settings } from 'lucide-react'
import { useRouter } from '@web/next-shims/navigation'
import { useEffect, useState } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import { ContactDialog, NotificationDialog } from '@web/components/UserDialogs'
import { Button } from '@web/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover'
import { Skeleton } from '@web/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { fetchNotifications } from '@web/components/UserDialogs/notificationData'
import { useNotificationStore } from '@web/store/notifications'
import { useUserStore } from '@web/store/user'
import { navigateToLogin } from '@web/utils/auth'
import { cn } from '@web/utils/className'
import { UserAvatar } from '@web/components/common/UserAvatar'
import { confirm } from '@web/utils/ui/confirm'

export interface UserDropdownMenuProps extends SidebarCommonProps {
  /** 打开设置弹框 */
  onOpenSettings: (defaultTab?: SettingsTab) => void
}

/** 菜单项组件 */
function MenuItem({
  icon: Icon,
  label,
  onClick,
  className,
}: {
  icon: React.ElementType
  label: string
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'btn btn-ghost btn-md w-full justify-start rounded-md text-foreground',
        className,
      )}
    >
      <Icon size={16} className="shrink-0" />
      <span className="flex-1 text-left">{label}</span>
    </button>
  )
}

/** 已登录用户的下拉菜单内容 */
function LoggedInMenuContent({
  onOpenSettings,
  onClose,
  onOpenContact,
  onOpenNotification,
}: {
  onOpenSettings: (defaultTab?: SettingsTab) => void
  onClose: () => void
  onOpenContact: () => void
  onOpenNotification: () => void
}) {
  const { t } = useTransClient(['common'])
  const userInfo = useUserStore(state => state.userInfo)
  const logout = useUserStore(state => state.logout)
  const unreadCount = useNotificationStore(state => state.unreadCount)
  const setItems = useNotificationStore(state => state.setItems)
  const router = useRouter()

  // 挂载时拉取真实公告（后端实时数据），计算未读角标；失败回退静态兜底
  useEffect(() => {
    let cancelled = false
    fetchNotifications().then(({ announcements }) => {
      if (!cancelled)
        setItems(announcements)
    })
    return () => { cancelled = true }
  }, [setItems])

  const handleOpenSettings = () => {
    onOpenSettings()
    onClose()
  }

  const handleLogout = async () => {
    const ok = await confirm({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      okText: '退出',
      okType: 'destructive',
    })
    if (!ok)
      return
    logout()
    onClose()
    router.push('/')
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-1 p-2">
        {/* 用户信息区域 */}
        <div className="flex items-center gap-3 px-3 py-2">
          <UserAvatar
            name={userInfo?.name}
            avatar={userInfo?.avatar}
            className="h-10 w-10"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span
              className="truncate text-sm font-medium text-foreground"
              data-testid="sidebar-user-name"
            >
              {userInfo?.name || t('common:unknownUser')}
            </span>
          </div>
        </div>

        <div className="my-1 h-px bg-border" />

        {/* 联系我们 */}
        <div data-testid="sidebar-contact-entry">
          <MenuItem icon={Mail} label={t('common:contactUs')} onClick={onOpenContact} />
        </div>

        {/* 消息通知 */}
        <div data-testid="sidebar-notification-entry">
          <div className="relative">
            <MenuItem icon={Bell} label={t('common:header.messages')} onClick={onOpenNotification} />
            {unreadCount > 0 && (
              <span className="absolute right-3 top-1/2 flex h-4 min-w-4 -translate-y-1/2 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </div>
        </div>

        {/* 设置（打开设置弹窗，与消息通知齿轮一致；替换原先独立设置页） */}
        <div data-testid="sidebar-settings-entry">
          <MenuItem icon={Settings} label={t('common:settings')} onClick={handleOpenSettings} />
        </div>

      </div>
  )
}

export function UserDropdownMenu({ collapsed, onOpenSettings }: UserDropdownMenuProps) {
  const token = useUserStore(state => state.token)
  const userInfo = useUserStore(state => state.userInfo)
  const hasHydrated = useUserStore(state => state._hasHydrated)
  const { t } = useTransClient('common')
  const [open, setOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [notificationOpen, setNotificationOpen] = useState(false)

  // 如果还未 hydrate 完成，显示骨架屏
  if (!hasHydrated) {
    if (collapsed) {
      return <Skeleton className="h-9 w-9 rounded-md" />
    }
    return <Skeleton className="mt-2 h-9 w-full rounded-md" />
  }

  // 内测免登录模式：不提供登录入口，始终显示用户下拉菜单（登录 UI 已整体移除）
  // 已登录状态显示下拉菜单
  return (
    <div
      className={cn(
        'flex items-center rounded-lg transition-colors hover:bg-accent',
        collapsed ? 'p-1' : 'mr-1 gap-2.5 px-0 py-1.5',
      )}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipProvider>
          <Tooltip>
            <PopoverTrigger asChild>
              <TooltipTrigger asChild>
                {/* 头像区域 - 点击打开用户菜单 */}
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setOpen(true)
                  }}
                  data-testid="sidebar-user-trigger"
                  className={cn(
                    'relative flex cursor-pointer items-center border-none bg-transparent flex-1',
                    collapsed ? 'justify-center' : 'justify-center gap-2.5',
                  )}
                >
                  <UserAvatar
                    name={userInfo?.name}
                    avatar={userInfo?.avatar}
                    className="h-8 w-8"
                  />

                  {!collapsed && (
                    <div className="flex min-w-14 flex-col items-center">
                      <span className="w-full truncate text-center text-sm font-medium text-foreground">
                        {userInfo?.name || t('unknownUser')}
                      </span>
                    </div>
                  )}
                </button>
              </TooltipTrigger>
            </PopoverTrigger>
            {collapsed && !open && (
              <TooltipContent side="right">
                <p>{t('profile')}</p>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>

        <PopoverContent
          side={collapsed ? 'right' : 'top'}
          align={collapsed ? 'end' : 'start'}
          className="w-64 p-0"
          sideOffset={4}
          data-testid="sidebar-user-menu"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <LoggedInMenuContent
            onOpenSettings={onOpenSettings}
            onClose={() => setOpen(false)}
            onOpenContact={() => {
              setOpen(false)
              setContactOpen(true)
            }}
            onOpenNotification={() => {
              setOpen(false)
              setNotificationOpen(true)
            }}
          />
        </PopoverContent>
      </Popover>

      {/* 弹窗必须渲染在 Popover 外部，否则 Popover 关闭会导致弹窗被卸载 */}
      <ContactDialog open={contactOpen} onOpenChange={setContactOpen} />
      <NotificationDialog open={notificationOpen} onOpenChange={setNotificationOpen} />
    </div>
  )
}
