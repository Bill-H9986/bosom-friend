/**
 * AccountEntry - 添加频道入口（侧边栏底部、头像上方）
 * 点击直接打开「频道管理」弹窗主视图（我的频道/刷新粉丝数/新建分组）。
 */
'use client'

import type { SidebarCommonProps } from '../../types'
import { CirclePlus } from 'lucide-react'
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
              // 与「管家团队 / 关于本产品」同一组：同一套左对齐与 8px 图标间距，
              // 原来这里单独 justify-center，三项在一列里起点参差。
              'flex w-full cursor-pointer items-center rounded-lg text-muted-foreground transition-colors duration-200 ease-apple-out hover:bg-accent hover:text-foreground',
              collapsed ? 'h-9 w-full justify-center' : 'gap-2 px-3 py-2',
            )}
          >
            {/* 图标与「管家团队」区分开：两个 Users 并排会看成同一件事 */}
            <CirclePlus size={18} className="text-primary" />
            {!collapsed && <span className="text-sm">添加频道</span>}
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
