/**
 * SectionHeader - 统一区块标题模板
 * 所有内容区块标题统一：section-title（左）+ 操作区（右）
 */
'use client'

import type { ReactNode } from 'react'
import { cn } from '@web/utils/className'

export interface SectionHeaderProps {
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function SectionHeader({ title, description, action, className }: SectionHeaderProps) {
  return (
    <div className={cn('mb-3 flex items-center justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="section-title">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

export default SectionHeader
