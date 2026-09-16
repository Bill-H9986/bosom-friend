/**
 * AccountEntry - 添加频道入口（侧边栏底部、头像上方）
 * 点击直接打开「频道管理」弹窗主视图（我的频道/刷新粉丝数/新建分组）。
 */
'use client'

import type { SidebarCommonProps } from '../../types'
import { Users } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { useChannelManagerStore } from '@web/components/ChannelManager'
import { cn } from '@web/utils/className'

export function AccountEntry({ collapsed }: SidebarCommonProps) {
  const openChannelManager = () => {
    // 固定主视图：不走 openModal 的新用户分支（0 账号时会被导向连接列表视图）。
    useChannelManagerStore.setState({ open: true, currentView: 'main', isNewUser: false })
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="sidebar-account-entry"
            onClick={openChannelManager}
            className={cn(
              'flex w-full cursor-pointer items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              'justify-center',
              collapsed ? 'h-9 w-full' : 'mr-1 gap-2.5 px-3 py-2',
            )}
          >
            <Users size={20} className="text-primary" />
            {!collapsed && <span className="min-w-14 text-center text-sm">添加频道</span>}
          </button>
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right">
            <p>添加频道</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  )
}
