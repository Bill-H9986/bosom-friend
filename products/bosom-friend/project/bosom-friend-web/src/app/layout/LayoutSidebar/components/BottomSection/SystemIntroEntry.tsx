/**
 * SystemIntroEntry - 系统介绍入口组件
 * （“我的频道”与“账号管理”已合并为同一个页面，仅保留系统介绍独立入口）
 */

'use client'

import type { SidebarCommonProps } from '../../types'
import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { cn } from '@web/utils/className'

export function SystemIntroEntry({ collapsed }: SidebarCommonProps) {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="#/"
              data-testid="sidebar-system-intro"
              className={cn(
                'flex flex-1 cursor-pointer items-center rounded-lg text-muted-foreground transition-colors hover:bg-brand-cyan/10 hover:text-brand-cyan',
                collapsed ? 'h-9 w-9 justify-center' : 'justify-between px-3 py-2',
              )}
            >
              <div className="flex items-center gap-2">
                <Info size={18} className="text-brand-cyan" />
                {!collapsed && <span className="text-sm">系统介绍</span>}
              </div>
            </a>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right">
              <p>系统介绍</p>
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
