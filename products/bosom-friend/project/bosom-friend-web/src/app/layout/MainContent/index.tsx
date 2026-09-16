/**
 * MainContent - 主内容区域包装组件
 * 根据当前路由动态控制顶部和底部间距（用于移动端顶部栏与底部导航栏占位）
 */
'use client'

import { useNavigationLogic } from '@web/app/layout/shared/hooks/useNavigationLogic'
import { cn } from '@web/utils/className'
// 窗口控制按钮位于桌面端 legacy 组件层（electron/src），Web 包经别名引用
import Windowcontrolbuttons from '@/components/WindowControlButtons/WindowControlButtons'

interface MainContentProps {
  children: React.ReactNode
  banner?: React.ReactNode
}

export function MainContent({ children, banner }: MainContentProps) {
  const { isAuthPage, isBottomNavHidden } = useNavigationLogic()

  return (
    <main
      className={cn(
        'relative flex-1 min-h-0 min-w-0 flex flex-col',
        // 非 auth 页面需要为移动端顶部栏和 BottomBar 留空间
        !isAuthPage && 'pt-14 md:pt-10',
        !isBottomNavHidden && 'pb-20 md:pb-0',
      )}
    >
      {/* 主内容区右上角窗口控制（不遮右侧 AI 面板收放按钮） */}
      {!isAuthPage && (
        <div className="fixed right-3 top-2 z-50 h-7">
          <Windowcontrolbuttons />
        </div>
      )}

      {/* 顶部窗口拖拽区：无边框窗口靠这里拖动（md+ 时顶部 40px 为空白留白区，不遮挡任何交互控件） */}
      {!isAuthPage && (
        <div
          aria-hidden
          data-testid="desktop-drag-region"
          className="app-drag-region absolute inset-x-0 top-0 z-0 hidden h-10 md:block"
        />
      )}
      {banner}
      <div
        id="main-content"
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      >
        {children}
      </div>
    </main>
  )
}
