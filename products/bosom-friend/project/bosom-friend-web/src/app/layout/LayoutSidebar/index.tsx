/**
 * LayoutSidebar - 左侧侧边栏布局组件
 * 包含 Logo、主导航、底部功能区（余额、插件）、用户下拉菜单
 * 支持展开/收缩两种状态
 */
'use client'

import type { IRouterDataItem } from '../routerData'
import type { NavItemData } from './types'
import { useShallow } from 'zustand/shallow'
import { useNavigationLogic, useVisibleRouterData } from '@web/app/layout/shared'
import { useSettingsModalStore } from '@web/store/settingsModal'
import { useUserStore } from '@web/store/user'
import { cn } from '@web/utils/className'
import { BottomSection, LogoSection, NavSection, UserDropdownMenu } from './components'
import { AccountEntry } from './components/BottomSection/AccountEntry'

/**
 * 侧边栏主组件
 */
function LayoutSidebar() {
  const { currRouter, isAuthPage } = useNavigationLogic()
  const visibleRoutes = useVisibleRouterData()

  // 获取侧边栏状态和设置方法
  const { sidebarCollapsed: collapsed, setSidebarCollapsed: setCollapsed } = useUserStore(
    useShallow(state => ({
      sidebarCollapsed: state.sidebarCollapsed,
      setSidebarCollapsed: state.setSidebarCollapsed,
    })),
  )

  const { openSettings } = useSettingsModalStore()

  const mapNavItem = (item: IRouterDataItem): NavItemData => ({
    path: item.path,
    translationKey: item.translationKey,
    icon: item.icon,
    children: item.children?.map(mapNavItem),
    onClick: item.onClick,
  })

  // 首页、auth、websit 页面不显示侧边栏
  if (isAuthPage) {
    return null
  }

  // 转换路由数据为 NavSection 所需格式
  const navItems = visibleRoutes.map(mapNavItem)

  return (
    <aside
      className={cn(
        'group sticky left-0 top-0 hidden h-screen flex-col border-r sidebar-divider-r border-sidebar-border bg-sidebar p-3 transition-all duration-[420ms] ease-apple md:flex',
        collapsed ? 'w-[68px] min-w-[68px]' : 'w-[240px] min-w-[240px]',
      )}
    >
      {/* Logo 区域 - 固定 */}
      <LogoSection collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />

      {/* 可滚动区域：主导航 */}
      <div
        className={cn(
          'flex-1 min-h-0 overflow-y-auto overflow-x-hidden',
          collapsed ? 'scrollbar-none' : 'scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent',
        )}
      >
        <NavSection items={navItems} currentRoute={currRouter!} collapsed={collapsed} />
      </div>

      {/* 底部固定区域 - 不随滚动 */}
      <div className="flex-shrink-0">
        {/* 添加频道入口（头像上方） */}
        <div className="pb-1">
          <AccountEntry collapsed={collapsed} />
        </div>
        {/* 底部功能区 */}
        <BottomSection collapsed={collapsed} onOpenSettings={openSettings} />

        {/* 用户下拉菜单 */}
        <div className="mt-2 border-t border-sidebar-border pt-2">
          <UserDropdownMenu collapsed={collapsed} onOpenSettings={openSettings} />
        </div>
      </div>
    </aside>
  )
}

export default LayoutSidebar
