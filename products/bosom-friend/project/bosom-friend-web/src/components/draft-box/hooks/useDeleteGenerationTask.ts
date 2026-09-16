/**
 * 删除单条生成记录（二次确认 + 结果提示）
 * 草稿/视频/图片各列表的生成中卡片共用
 */

'use client'

import { useCallback } from 'react'
import { usePlanDetailStore } from '@web/store/draft-box/planDetailStore'
import { confirm } from '@web/utils/ui/confirm'
import { toast } from '@web/utils/ui/toast'

export function useDeleteGenerationTask() {
  const deleteGenerationTasks = usePlanDetailStore(state => state.deleteGenerationTasks)

  return useCallback(async (taskId: string) => {
    const confirmed = await confirm({
      title: '删除生成记录',
      content: '确定删除这条生成记录吗？此操作不可恢复。',
      okType: 'destructive',
      okText: '删除',
    })
    if (!confirmed)
      return

    const ok = await deleteGenerationTasks([taskId])
    if (ok)
      toast.success('已删除生成记录')
    else
      toast.error('删除生成记录失败')
  }, [deleteGenerationTasks])
}
