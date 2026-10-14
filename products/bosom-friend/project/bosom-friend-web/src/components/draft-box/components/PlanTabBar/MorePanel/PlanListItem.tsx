/**
 * PlanListItem - 更多面板中的计划列表项
 * 显示计划名称、选中状态、编辑/删除操作
 */

'use client'

import type { PromotionPlan } from '@web/api/materials/material.types'
import { Check, Pencil, Trash2 } from 'lucide-react'
import { useTransClient } from '@web/app/i18n/client'
import { cn } from '@web/utils/className'

interface PlanListItemProps {
  plan: PromotionPlan
  isSelected: boolean
  onSelect: (planId: string) => void
  onEdit: (plan: PromotionPlan) => void
  onDelete: (plan: PromotionPlan) => void
}

function PlanListItem({
  plan,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
}: PlanListItemProps) {
  const { t } = useTransClient('brandPromotion')
  /**
   * 默认素材组不许删：它是内容创作的首屏落点，也是所有"没指定分组"的内容的归属
   * （REST 里不传 groupId 一律落到它）。删掉它，那些内容就成了孤儿——列表里再也看不到，
  * 用户只会觉得"我的东西没了"。服务端同样拒绝（界面禁用只是提前告知）。
   */
  const isDefault = plan.isDefault === true

  return (
    <div
      className={cn(
        'flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors',
        'hover:bg-accent',
        isSelected && 'bg-accent',
      )}
      onClick={() => onSelect(plan.id)}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {isSelected && (
          <Check className="h-4 w-4 text-primary shrink-0" />
        )}
        <span className={cn(
          'text-sm truncate',
          isSelected && 'font-medium text-primary',
        )}
        >
          {plan.name || plan.title}
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0 ml-2">
        <button
          className="p-1.5 rounded-md hover:bg-muted cursor-pointer transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            onEdit(plan)
          }}
          title={t('planTab.editPlan')}
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
        <button
          className={cn(
            'rounded-md p-1.5 transition-colors',
            isDefault ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-destructive/10',
          )}
          disabled={isDefault}
          onClick={(e) => {
            e.stopPropagation()
            if (isDefault)
              return
            onDelete(plan)
          }}
          title={isDefault ? '默认素材组不能删（内容创作的首屏落点）' : t('planTab.deletePlan')}
        >
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      </div>
    </div>
  )
}

export default PlanListItem
