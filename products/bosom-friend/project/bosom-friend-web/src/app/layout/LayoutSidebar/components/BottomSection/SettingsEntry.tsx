/**
 * SettingsEntry - 设置入口组件
 */

'use client'

import type { SidebarCommonProps } from '../../types'
import { Settings } from 'lucide-react'
import { useTransClient } from '@web/app/i18n/client'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { cn } from '@web/utils/className'

interface SettingsEntryProps extends SidebarCommonProps {
  onClick: () => void
  hasUnreadOpsTicket?: boolean
}

export function SettingsEntry({ collapsed, onClick, hasUnreadOpsTicket }: SettingsEntryProps) {
  const { t } = useTransClient('common')

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClick}
            className={cn(
              'btn btn-ghost text-muted-foreground hover:text-foreground',
              collapsed ? 'btn-icon' : 'btn-md w-full justify-start',
            )}
          >
            <span className="relative flex items-center justify-center">
              <Settings size={18} />
              {hasUnreadOpsTicket && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive" data-testid="sidebar-settings-ticket-unread-dot" />
              )}
            </span>
            {!collapsed && <span className="text-sm">{t('settings')}</span>}
          </button>
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right">
            <p>{t('settings')}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  )
}
