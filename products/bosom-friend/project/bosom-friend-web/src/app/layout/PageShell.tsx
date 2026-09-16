/**
 * PageShell - 功能页母版
 *
 * 全站所有功能页统一使用本组件，保证结构、标签、DIV 盒子完全一致：
 *   <div class="page-shell">               页面最外层盒子
 *     <header class="page-header">         顶部栏
 *       <h1 class="page-title">标题</h1>   页面标题（H1）
 *       <nav class="page-tabs">标签组</nav> 页面标签（同规格按钮）
 *       <操作区 />                         右侧操作按钮
 *     </header>
 *     <div class="page-toolbar">工具条</div> 第二行工具条（可选）
 *     <main class="page-content">内容区</main>
 *   </div>
 *
 * 后续新增功能页直接套用母版，统一风格由母版一处维护。
 */
'use client'

import type { ReactNode } from 'react'
import { cn } from '@web/utils/className'

export interface PageTab {
  key: string
  label: string
}

export interface PageShellProps {
  /** 页面标题（H1，可选）；不传时顶部栏只保留标签/操作区（如发布日历/数据中心） */
  title?: string
  /** 页面标签（可选，同规格按钮） */
  tabs?: PageTab[]
  /** 当前激活标签 key */
  activeTab?: string
  /** 标签点击回调 */
  onTabChange?: (key: string) => void
  /** 标签组右侧附加节点（如下拉菜单） */
  tabExtra?: ReactNode
  /** 顶部栏右侧操作区 */
  actions?: ReactNode
  /** 第二行工具条（搜索/筛选等，可选） */
  toolbar?: ReactNode
  /** 内容区附加类名（需要全宽内容时传 p-0） */
  contentClassName?: string
  children: ReactNode
}

export function PageShell({
  title,
  tabs,
  activeTab,
  onTabChange,
  tabExtra,
  actions,
  toolbar,
  contentClassName,
  children,
}: PageShellProps) {
  const hasTabs = tabs && tabs.length > 0
  const hasHeader = Boolean(title) || hasTabs || Boolean(actions)

  return (
    <div className="page-shell">
      {hasHeader && (
        <header className="page-header">
          {title && <h1 className="page-title">{title}</h1>}
          {hasTabs && (
          <nav className="page-tabs" aria-label={title || '功能页标签'}>
            {tabs.map(tab => (
              <button
                key={tab.key}
                type="button"
                onClick={() => onTabChange?.(tab.key)}
                className={cn('page-tab', tab.key === activeTab ? 'page-tab-active' : 'page-tab-idle')}
              >
                {tab.label}
              </button>
            ))}
            {tabExtra}
          </nav>
        )}
        {actions && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {actions}
          </div>
        )}
        </header>
      )}
      {toolbar && (
        <div className="page-toolbar">
          {toolbar}
        </div>
      )}
      <main className={cn('page-content', contentClassName)}>
        {children}
      </main>
    </div>
  )
}

export default PageShell
