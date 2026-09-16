/**
 * PlanTabBar - 草稿箱 Tab 栏
 * 可滚动 Tab + 更多按钮 + 新建按钮
 * 两页面（线下推广 / 草稿箱）复用
 */

'use client'

import { Ellipsis, Plus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@web/app/i18n/client'
import { Button } from '@web/components/ui/button'
import { Skeleton } from '@web/components/ui/skeleton'
import { useIsMobile } from '@web/hooks/useIsMobile'
import { useBrandPromotionStore } from '@web/store/draft-box/brandPromotionStore'
import { usePlanTabStore } from '@web/store/draft-box/planTabStore'
import { cn } from '@web/utils/className'
import MorePanel from './MorePanel'
import styles from './PlanTabBar.module.scss'

interface PlanTabBarProps {
  onPlanChange?: (planId: string) => void
}

function PlanTabBar({ onPlanChange }: PlanTabBarProps) {
  const { t } = useTransClient('brandPromotion')
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeTabRef = useRef<HTMLButtonElement>(null)

  const {
    tabPlans,
    tabPlansLoading,
    selectedPlanId,
  } = usePlanTabStore(
    useShallow(state => ({
      tabPlans: state.tabPlans,
      tabPlansLoading: state.tabPlansLoading,
      selectedPlanId: state.selectedPlanId,
    })),
  )

  const selectPlan = usePlanTabStore(state => state.selectPlan)
  const openCreatePlanModal = useBrandPromotionStore(state => state.openCreatePlanModal)

  // PC端鼠标滚轮水平滚动
  useEffect(() => {
    const el = scrollRef.current
    if (!el || isMobile)
      return

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0)
        return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isMobile])

  // 选中 Tab 后自动滚动到容器水平居中位置
  useEffect(() => {
    if (activeTabRef.current && scrollRef.current) {
      const container = scrollRef.current
      const tab = activeTabRef.current
      const scrollLeft = tab.offsetLeft - container.offsetWidth / 2 + tab.offsetWidth / 2
      container.scrollTo({ left: scrollLeft, behavior: 'smooth' })
    }
  }, [selectedPlanId])

  const handleTabClick = (planId: string) => {
    if (planId === selectedPlanId) {
      return
    }
    selectPlan(planId)
    onPlanChange?.(planId)
  }

  if (tabPlansLoading) {
    return (
      <div className="flex h-12 items-center gap-2 border-b border-border/60 px-4 md:px-6">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
    )
  }

  // 只有一个工作组时不显示标签栏：产品只有一个工作空间，单标签没有可切换的对象，
  // 显示出来只会让页面多一条没有信息量的横条。
  if (tabPlans.length <= 1)
    return null

  return (
    <div className="flex h-12 items-center gap-2 border-b border-border/60 bg-background px-4 md:px-6">
      {/* 可滚动 Tab 区域 */}
      <div
        ref={scrollRef}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1 overflow-x-auto',
          styles.scrollContainer,
        )}
      >
        {tabPlans.map(plan => (
          <button
            key={plan.id}
            ref={plan.id === selectedPlanId ? activeTabRef : undefined}
            className={cn(
              'page-tab shrink-0',
              plan.id === selectedPlanId ? 'page-tab-active' : 'page-tab-idle',
            )}
            onClick={() => handleTabClick(plan.id)}
          >
            {(plan.name || plan.title) === 'Default' ? '默认草稿箱' : plan.name || plan.title}
          </button>
        ))}
      </div>

    </div>
  )
}

export default PlanTabBar
