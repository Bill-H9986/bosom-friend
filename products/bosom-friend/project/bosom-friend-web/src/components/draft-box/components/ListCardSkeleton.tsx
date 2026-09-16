/**
 * ListCardSkeleton - 内容列表卡片骨架屏
 * 按 index 取不同高度，模拟瀑布流中图片的随机比例
 */

'use client'

import { Skeleton } from '@web/components/ui/skeleton'

const SKELETON_HEIGHTS = [120, 160, 200, 140, 180, 150, 170, 190]

export function ListCardSkeleton({ index }: { index: number }) {
  const height = SKELETON_HEIGHTS[index % SKELETON_HEIGHTS.length]

  return (
    <div className="mb-4">
      <Skeleton className="w-full rounded-xl" style={{ height: `${height}px` }} />
      <div className="pt-2 px-1">
        <Skeleton className="h-4 w-full" />
      </div>
    </div>
  )
}
