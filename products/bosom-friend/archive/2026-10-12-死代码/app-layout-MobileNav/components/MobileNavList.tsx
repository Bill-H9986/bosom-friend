/**
 * MobileNavList - 移动端导航列表
 * 路由导航可折叠/展开（持久化）
 */
import type { MobileNavListProps } from '../types'
import type { IRouterDataItem } from '@web/app/layout/routerData'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@web/app/i18n/client'
import { useVisibleRouterData } from '@web/app/layout/shared/hooks/useVisibleRouterData'
import { useSystemStore } from '@web/store/system'
import { cn } from '@web/utils/className'
import { MobileMyChannelsButton } from './MobileMyChannelsButton'
import { MobileNavItem } from './MobileNavItem'

function isRouteActive(item: IRouterDataItem, currentRoute: string): boolean {
  if (item.path === currentRoute) {
    return true
  }

  return item.children?.some(child => isRouteActive(child, currentRoute)) ?? false
}

export function MobileNavList({ currentRoute, onClose, onOpenMyChannels }: MobileNavListProps) {
  const { t } = useTransClient(['route', 'common'])
  const visibleRoutes = useVisibleRouterData()

  const { mobileNavExpanded, setMobileNavExpanded } = useSystemStore(
    useShallow(state => ({
      mobileNavExpanded: state.mobileNavExpanded,
      setMobileNavExpanded: state.setMobileNavExpanded,
    })),
  )

  const renderRouteItem = (item: IRouterDataItem, level = 0): React.ReactNode => {
    const isActive = isRouteActive(item, currentRoute)

    return (
      <div key={item.path || item.translationKey} className="space-y-1">
        {item.path ? (
          <MobileNavItem
            path={item.path}
            translationKey={item.translationKey}
            icon={level === 0 ? item.icon : undefined}
            isActive={isActive}
            onClose={onClose}
            className={cn(level > 0 && 'ml-6 py-2.5 text-sm')}
          />
        ) : null}
        {item.children?.length ? (
          <div className={cn('space-y-1 border-l border-border/70 pl-2', level === 0 && 'ml-4')}>
            {item.children.map((child: IRouterDataItem) => renderRouteItem(child, level + 1))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <nav className="flex flex-col gap-1 p-4" data-testid="mobile-nav-list">
      {/* 导航折叠/展开按钮 */}
      <button
        onClick={() => setMobileNavExpanded(!mobileNavExpanded)}
        className={cn(
          'flex items-center gap-3 px-4 py-3 rounded-lg text-base font-medium transition-all w-full cursor-pointer',
          'text-muted-foreground hover:bg-brand-cyan/10 hover:text-brand-cyan',
          mobileNavExpanded && 'bg-brand-cyan/10 text-brand-cyan',
        )}
        data-testid="mobile-nav-toggle"
      >
        <span className="flex-1 text-left">{t('route:navigation')}</span>
        {mobileNavExpanded ? (
          <ChevronUp size={18} className="text-muted-foreground" />
        ) : (
          <ChevronDown size={18} className="text-muted-foreground" />
        )}
      </button>

      {/* 路由导航项 - 折叠/展开 */}
      {mobileNavExpanded && (
        <div className="flex flex-col gap-1" data-testid="mobile-nav-routes">
          {visibleRoutes.map((item: IRouterDataItem) => renderRouteItem(item))}

          {/* 我的频道 */}
          <MobileMyChannelsButton onClose={onClose} onOpenMyChannels={onOpenMyChannels} />

        </div>
      )}
    </nav>
  )
}
