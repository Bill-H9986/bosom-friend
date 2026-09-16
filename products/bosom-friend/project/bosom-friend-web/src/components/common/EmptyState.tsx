/**
 * EmptyState - 统一空状态模板
 * 所有"暂无数据/空列表"场景统一使用：图标 + 标题 + 说明 + 操作按钮
 */
'use client'

import type { ReactNode } from 'react'
import { cn } from '@web/utils/className'

export interface EmptyStateProps {
  /** 图标（建议 16 尺寸的 lucide 图标） */
  icon?: ReactNode
  /** 标题 */
  title: string
  /** 说明文字（可选） */
  description?: string
  /** 操作按钮（可选） */
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex min-h-[calc(100vh-260px)] flex-col items-center justify-center gap-3 px-4 py-12 text-center', className)}>
      {icon && (
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground/50">
          {icon}
        </span>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export default EmptyState
