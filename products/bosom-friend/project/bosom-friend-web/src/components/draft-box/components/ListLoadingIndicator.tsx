/**
 * ListLoadingIndicator - 列表加载更多指示器
 * 未传 label 时只显示转圈（媒体列表），传入 label 时同时显示文案（草稿/全部列表）
 */

'use client'

import { memo } from 'react'

const ListLoadingIndicator = memo(({ label }: { label?: string }) => (
  <div className="flex justify-center py-4">
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      {label === undefined ? null : <span>{label}</span>}
    </div>
  </div>
))

ListLoadingIndicator.displayName = 'ListLoadingIndicator'

export { ListLoadingIndicator }
