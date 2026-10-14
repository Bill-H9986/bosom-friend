/**
 * TeamEntry - 管家团队入口。
 *
 * 管家团队是 ADR-005 的三区之一（对话 / 管家团队 / 看板），但导航收敛属后续步骤 S4：
 * 这一版**不动** `routerData.tsx` 的 7 项主导航，先按「关于本产品」的同一模式在底部功能区
 * 给出可见入口，让这一页在界面上真的走得通（/team 路由见 electron `src/router/index.tsx`）。
 */
'use client'

import type { SidebarCommonProps } from '../../types'
import { Users } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { cn } from '@web/utils/className'

export function TeamEntry({ collapsed }: SidebarCommonProps) {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="#/team"
              data-testid="sidebar-team"
              className={cn(
                'flex flex-1 cursor-pointer items-center rounded-lg text-muted-foreground transition-colors hover:bg-brand-cyan/10 hover:text-brand-cyan',
                collapsed ? 'h-9 w-9 justify-center' : 'justify-between px-3 py-2',
              )}
            >
              <div className="flex items-center gap-2">
                <Users size={18} className="text-brand-cyan" />
                {!collapsed && <span className="text-sm">管家团队</span>}
              </div>
            </a>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right">
              <p>管家团队</p>
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}

export default TeamEntry
