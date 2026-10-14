/**
 * 动作回填台账在页面内的传递通道（DEF-248）。
 *
 * 台账挂在任务详情（`task.actionResults`）上，而动作卡渲染在消息列表深处，
 * 中间隔着 ChatMessageList / ChatMessage 两层与它无关的组件。逐层加 props 要把
 * 这份数据穿过整条链路；这里用 context：详情页注入，动作卡按自己的 requestId 取一条。
 *
 * 没有 Provider 时值是 null（右侧 AI 面板、AI 互动页等），动作卡不显示状态行——
 * 「未回填」是任务详情里的结论，不该出现在拿不到台账的地方。
 */
'use client'

import type { TaskActionResult } from '@web/api/ai/ai.types'
import { createContext, useContext, useEffect, useState } from 'react'
import { cn } from '@web/utils/className'

const ActionResultsContext = createContext<TaskActionResult[] | null>(null)

/** 回填广播的订阅者签名。 */
type ActionResultListener = (result: TaskActionResult) => void

/**
 * 本会话内刚刚回填成功的结果。
 *
 * 台账是任务详情拉下来的快照，回填之后它不会自己变；没有这条广播，用户点完
 * "存进草稿箱"看到的状态行仍是「未回填」，与刚弹出的成功提示自相矛盾。
 */
const actionResultListeners = new Set<ActionResultListener>()

/**
 * 广播一条服务端已确认的回填结果。
 *
 * @param result - 已落库的那条记录。
 */
export function publishActionResult(result: TaskActionResult): void {
  for (const listener of actionResultListeners) listener(result)
}

/**
 * 注入当前任务的动作回填台账。
 *
 * @param props.results - 台账数组；null 表示此处不展示动作状态。
 * @param props.children - 被包裹的内容。
 */
export function ActionResultsProvider({ results, children }: { results: TaskActionResult[] | null, children: React.ReactNode }) {
  return <ActionResultsContext.Provider value={results}>{children}</ActionResultsContext.Provider>
}

/**
 * 读取当前任务的回填台账。
 *
 * @returns 台账数组；null 表示此处不展示动作状态（上层没有 Provider）。
 */
export function useActionResults(): TaskActionResult[] | null {
  return useContext(ActionResultsContext)
}

/** 状态行要显示的三件事：标签、补充说明、标签配色。 */
interface IActionStateView {
  label: string
  detail: string
  badgeClass: string
}

/**
 * 把一条回填记录翻成用户看得懂的一句话。
 *
 * @param record - 该工单的回填记录；缺省表示没有回填。
 * @returns 标签、补充说明与配色。
 */
function describeActionState(record: TaskActionResult | undefined): IActionStateView {
  if (record === undefined) {
    return {
      label: '已申请 · 未回填',
      detail: '这一步还没有回填执行结果，不代表已经做完。',
      badgeClass: 'border-border bg-muted text-muted-foreground',
    }
  }
  const parts: string[] = []
  if (record.note !== '') parts.push(record.note)
  if (record.realId !== '') parts.push(`真实 id：${record.realId}`)
  const detail = parts.join(' · ')
  if (record.state === 'verified') {
    return { label: '已核验', detail, badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700' }
  }
  if (record.state === 'failed') {
    return { label: '执行失败', detail, badgeClass: 'border-rose-200 bg-rose-50 text-rose-700' }
  }
  return { label: '已执行', detail, badgeClass: 'border-sky-200 bg-sky-50 text-sky-700' }
}

/**
 * 动作状态行：把「已申请 → 已执行 → 已核验」画在动作卡上。
 *
 * 只有上层注入过台账（任务详情）才渲染；台账里查不到本工单时显示「未回填」，
 * 宁可说没回填，也不把"申请了"当成"做完了"。
 *
 * @param props.requestId - 本条动作的工单号（动作卡上的 requestId）。
 * @param props.declared - 服务端在**这张卡自己身上**给出的执行结论。内核工具已经落库时
 *   （例如 `bosom_content_create_draft` 自己写进草稿箱并回传真实 id），服务端会直接把卡
 *   标成 `state: 'executed'`（DEF-270）——那时台账快照可能还没重新拉，卡片却已经知道做完了。
 *   它排在最后一位：台账里真有的记录永远优先，卡片自述只在查不到时兜底。
 * @param props.className - 追加的类名。
 */
export function ActionStateRow({ requestId, declared, className }: { requestId?: string, declared?: TaskActionResult, className?: string }) {
  const results = useActionResults()
  const [freshResult, setFreshResult] = useState<TaskActionResult | null>(null)

  // 本次会话刚回填的结果优先于台账快照：服务端已经写进去了，界面上不该还挂着「未回填」。
  useEffect(() => {
    if (requestId === undefined || requestId === '') return
    const listener: ActionResultListener = (result) => {
      if (result.requestId === requestId) setFreshResult(result)
    }
    actionResultListeners.add(listener)
    return () => {
      actionResultListeners.delete(listener)
    }
  }, [requestId])

  if (results === null) return null
  const record = freshResult
    ?? (requestId === undefined || requestId === '' ? undefined : results.find(item => item.requestId === requestId))
    ?? declared
  const view = describeActionState(record)
  return (
    <div className={cn('mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 pt-2', className)}>
      <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', view.badgeClass)}>
        {view.label}
      </span>
      {view.detail !== '' && <span className="text-xs text-muted-foreground">{view.detail}</span>}
    </div>
  )
}
