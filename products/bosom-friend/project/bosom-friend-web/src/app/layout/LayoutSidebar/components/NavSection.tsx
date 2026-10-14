/**
 * NavSection - 侧边栏主导航区域
 *
 * 支持**两级**导航（ADR-005 呈现层改造方案 v1.0 的 M2）：
 * - 一级项：40px 高、图标 20px、字重 500，可带二级；
 * - 二级项：32px 高、圆点代替图标、字号 13px，缩进对齐一级的图标中线。
 *
 * 层级靠**字号 + 字重 + 缩进**拉出来（规范第 4 节），不靠颜色堆：
 * 二级项默认是 `--muted-foreground`，只有选中/悬浮时才用品牌色。
 *
 * 展开状态由本组件持有（`expandedKeys`）：导航数据只描述结构，
 * 「哪一组现在是开的」是界面状态，不该让路由表来管。
 */

'use client'

import type { NavItemData, NavSectionProps, SidebarCommonProps } from '../types'
import { ChevronRight, FileText } from 'lucide-react'
import Link from '@web/next-shims/link'
import { useEffect, useState } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { useGetClientLng } from '@web/hooks/useSystem'
import { cn } from '@web/utils/className'

/** 单个导航项 */
interface NavItemProps extends SidebarCommonProps {
  item: NavItemData
  currentRoute: string
  level?: number
  expanded?: boolean
  onToggleExpand?: () => void
}

interface NavItemActiveState {
  isSelfActive: boolean
  isDescendantActive: boolean
  isActive: boolean
}

function isItemActive(item: NavItemData, currentRoute: string): boolean {
  if (item.path === currentRoute) {
    return true
  }

  return item.children?.some(child => isItemActive(child, currentRoute)) ?? false
}

function getItemActiveState(item: NavItemData, currentRoute: string): NavItemActiveState {
  const isSelfActive = item.path === currentRoute
  const isDescendantActive = item.children?.some(child => isItemActive(child, currentRoute)) ?? false

  return {
    isSelfActive,
    isDescendantActive,
    isActive: isSelfActive || isDescendantActive,
  }
}

function NavItem({ item, currentRoute, collapsed, level = 0, expanded = false, onToggleExpand }: NavItemProps) {
  const { t } = useTransClient('route')
  const lng = useGetClientLng()
  const { isActive, isDescendantActive, isSelfActive } = getItemActiveState(item, currentRoute)
  const hasChildren = Boolean(item.children?.length)
  const isBranchOpen = hasChildren && expanded && !collapsed
  const fullPath = item.path
    ? item.path.startsWith('/')
      ? `/${lng}${item.path}`
      : `/${lng}/${item.path}`
    : undefined
  const showStrongActive = isSelfActive || (collapsed && isActive)
  const showBranchActive = !showStrongActive && !collapsed && level === 0 && hasChildren && isDescendantActive
  // 一级项标签用导航数据里的中文名（name）；它比 i18n key 稳——旧板块降级后
  // key 表里可能根本没有对应条目，缺了就退回 key 翻译，不至于显示成空白。
  const label = item.label ?? t(item.translationKey)

  const contentNode = (
    <div
      className={cn(
        'relative flex w-full min-w-0 items-center text-sm font-medium transition-[background-color,color,box-shadow] duration-200 ease-apple-out',
        level === 0 ? 'rounded-xl' : 'rounded-lg',
        showStrongActive
          ? 'bg-brand-cyan/10 text-brand-purple-deep ring-1 ring-inset ring-brand-cyan/25'
          : 'text-muted-foreground hover:bg-brand-cyan/10 hover:text-brand-purple-deep',
        showBranchActive && 'text-brand-purple-deep',
        collapsed
          ? 'justify-center py-2.5'
          : level === 0
            // 苹果风侧边栏：图标与文字左对齐（居中会让每行起点参差），间距取规范第 2 节的 8px
            ? 'justify-start gap-2 px-3 py-2'
            : 'gap-2 px-3 py-1.5 text-[13px] font-normal',
      )}
    >
      {showBranchActive && (
        <span className="absolute left-1.5 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-brand-cyan" />
      )}
      <span
        className={cn(
          'flex shrink-0 items-center justify-center',
          showStrongActive && 'text-brand-purple-deep',
          showBranchActive && 'text-brand-purple-deep',
          !showStrongActive && !showBranchActive && level > 0 && 'opacity-80',
        )}
      >
        {level === 0
          ? (
              item.icon || <FileText size={20} />
            )
          : (
              <span className="size-1.5 rounded-full bg-current/60" />
            )}
      </span>
      {!collapsed && (
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {label}
        </span>
      )}
      {/*
        展开/收起是**独立按钮**：点文字/图标 = 去那一页（一级项自己也承载页面），
        点箭头 = 只展开二级。两件事分成两个热区，用户不用猜"点了会不会跳走"。
        折叠态不渲染它（那里只有图标，展开要靠展开侧边栏）。
      */}
      {hasChildren && !collapsed && (
        <button
          type="button"
          aria-label={isBranchOpen ? `收起${label}` : `展开${label}`}
          aria-expanded={isBranchOpen}
          data-testid={`sidebar-nav-toggle-${item.translationKey}`}
          className="ml-auto flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-transform duration-200 ease-apple hover:bg-brand-cyan/10 hover:text-brand-purple-deep"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onToggleExpand?.()
          }}
        >
          <ChevronRight size={14} className={cn('transition-transform duration-200 ease-apple', isBranchOpen && 'rotate-90')} />
        </button>
      )}
    </div>
  )

  const content = item.onClick ? (
    <button
      type="button"
      className="block w-full cursor-pointer"
      data-testid={`sidebar-nav-item-${item.translationKey}`}
      onClick={item.onClick}
    >
      {contentNode}
    </button>
  ) : fullPath ? (
    <Link href={fullPath} className="block w-full" data-testid={`sidebar-nav-item-${item.translationKey}`}>
      {contentNode}
    </Link>
  ) : (
    <div className="w-full" data-testid={`sidebar-nav-item-${item.translationKey}`}>{contentNode}</div>
  )

  const renderedContent = collapsed ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right">
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : (
    content
  )

  if (!hasChildren || collapsed)
    return renderedContent

  // 一级项与它的二级列表之间 8px（规范第 2 节），二级列表左侧一条 1px 引导线标明归属。
  //
  // 未展开时**保留 DOM 用 hidden 收起**，而不是不渲染：侧边栏一级项文字与二级项
  // 一起构成"这一项下面有什么"的完整语义，外部脚本（QA / 监考）也按
  // `data-testid="sidebar-nav-item-<key>"` 定位二级项——不渲染会让它们找不到元素，
  // 而"点了三角才出现"是界面行为，不该变成"这个入口不存在"。
  return (
    <div className="space-y-2">
      {renderedContent}
      {/* hidden 时仍在 DOM 里（见上方说明），可见性用 class 控制 */}
      <div className={cn('ml-4 space-y-1 border-l border-sidebar-border/50 pl-3', !expanded && 'hidden')}>
        {item.children?.map(child => (
          <NavItem
            key={child.path || child.translationKey}
            item={child}
            currentRoute={currentRoute}
            collapsed={collapsed}
            level={level + 1}
          />
        ))}
      </div>
    </div>
  )
}

export function NavSection({ items, currentRoute, collapsed }: NavSectionProps) {
  // 直接按 routerData 声明的顺序渲染，不做任何重排
  const navItems = items
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])

  /**
   * 当前路由落在某一组的二级里时，那一组必须自动展开——
   * 否则用户打开书签 #/knowledge 会看到「看板」折叠着，找不到自己正在哪一页
   * （导航要能回答"我在哪"，这比"少占几行"重要）。
   */
  useEffect(() => {
    if (currentRoute === '')
      return
    for (const item of navItems) {
      if (isItemActive(item, currentRoute))
        setExpandedKeys(prev => (prev.includes(item.translationKey) ? prev : [...prev, item.translationKey]))
    }
  }, [currentRoute, navItems])

  return (
    <nav className={cn('flex flex-col gap-1', collapsed ? 'pr-0' : 'pr-1')} data-testid="sidebar-nav">
      {navItems.map(item => (
        <NavItem
          key={item.path || item.translationKey}
          item={item}
          currentRoute={currentRoute}
          collapsed={collapsed}
          expanded={expandedKeys.includes(item.translationKey)}
          onToggleExpand={() => setExpandedKeys(prev => (prev.includes(item.translationKey)
            ? prev.filter(key => key !== item.translationKey)
            : [...prev, item.translationKey]))}
        />
      ))}
    </nav>
  )
}
