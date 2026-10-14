/**
 * Panel - 内容面板母版
 *
 * 页面内容区里"一整块内容"统一用本组件承载：作品列表、表单区、指标组、空态容器等。
 * 圆角、边框、背景、内边距、标题区只有这一处定义，页面不再各自拼圆角/边框/背景/内边距工具类。
 *
 * 为什么需要它：此前同一个视觉角色有四种写法并存——内联 `rounded-2xl border bg-card`（无内边距）、
 * 内联 `rounded-xl border bg-card`（圆角小一号）、shadcn Card（圆角 8 / p-6）、`.panel` 类。
 * 圆角 8/12/16、内边距 0/16/24 混用，同一列卡片因此永远对不齐。
 *
 * 内边距用 `p-4 sm:p-6` 而不是 `.panel` 自带的 `p-4`：`.panel` 是 globals.css 里的普通类，
 * twMerge 看不见它的内边距，而本组件用 Tailwind 工具类写，才能真正做到"传进来的 className 覆盖它"。
 *
 * @example
 * <Panel title="全部" extra={<Button size="sm">生成记录</Button>}>…列表…</Panel>
 * <Panel header={<TabsList />} className="p-4 pb-0">…</Panel>
 */
'use client'

import * as React from 'react'
import { cn } from '@web/utils/className'

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 面板标题（左）；不传则不出标题行 */
  title?: React.ReactNode
  /** 标题行右侧操作区（按钮/下拉等） */
  extra?: React.ReactNode
  /** 面板描述，位于标题下方一行小字 */
  description?: React.ReactNode
  /** 整行替换标题行（需要标签组/复杂头部时用）；与 title/extra/description 互斥 */
  header?: React.ReactNode
  /** 内容区去掉面板内边距（全宽列表/表格自接管时用） */
  flush?: boolean
}

export const Panel = React.forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { className, title, extra, description, header, flush = false, children, ...props },
  ref,
) {
  const hasTitleRow = title !== undefined || extra !== undefined || description !== undefined
  const hasHeader = header !== undefined || hasTitleRow
  return (
    <div
      ref={ref}
      className={cn('panel', 'p-4 sm:p-6', flush && 'p-0 sm:p-0', className)}
      {...props}
    >
      {header !== undefined
        ? <div className="mb-3">{header}</div>
        : hasTitleRow && (
          <div className="panel-header mb-3">
            <div className="min-w-0">
              {title !== undefined && <h3 className="card-title">{title}</h3>}
              {description !== undefined && <p className="text-caption mt-1">{description}</p>}
            </div>
            {extra !== undefined && <div className="flex shrink-0 items-center gap-2">{extra}</div>}
          </div>
        )}
      {children}
    </div>
  )
})

export default Panel
