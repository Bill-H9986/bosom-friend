/**
 * PendingDecisions - 待拍板清单（ADR-005 呈现层改造方案 v1.0 的 N4）。
 *
 * 依据 BFS-105.1：**只有四类动作需要用户拍板**——发布、删除、花钱、对外沟通。
 * 这里把散在各条任务里的这类动作卡集中到一处，卡片本身复用聊天里的
 * `ActionCard`（含它的授权语义与"已申请 / 已执行 / 未回填"状态行），不另做一套。
 *
 * **口径（说清哪几类现在收得到、哪几类收不到）**：
 * - 发布：`navigateToPublish`——内容已备好、等你点头才发（DEF-240 的授权语义在卡片里）。
 * - 花钱：`insufficientCredits`——积分不足要去充值，是花钱。
 * - 删除、对外沟通：**当前链路上没有对应的待办卡**——内核还没有删除类动作；
 *   评论 / 私信的回复在接待页里处理，不走"申请 → 拍板"的工单。界面上如实标注，
 *   不假装"四类都在这里"。有了对应的动作类型时，在 `classifyPendingAction` 补一个 case。
 *
 * 其余动作（存草稿、改草稿、页面导航、账号授权这类必要前置）一律不进清单——
 * BFS-105.2 明确"其余动作必须自动完成，不得用确认弹窗打扰用户"；
 * 导航类卡片（如 `navigateToReception`）只是"带你去某个页面"，不是需要点头的决定。
 */
'use client'

import type { IPendingDecisionItem } from '../types'
import type { IActionCard } from '@web/store/agent'
import { CircleAlert, Loader2 } from 'lucide-react'
import { ActionResultsProvider } from '@web/components/Chat/ActionCard/ActionResultsContext'
import { ActionCard } from '@web/components/Chat/ActionCard'
import { AgentRoleBadge } from '@web/components/Chat/AgentRoleBadge'
import { cn } from '@web/utils/className'
import { cardSurfaceFlat } from '@web/utils/card'
import { formatRelativeTime } from '@web/utils/format'

/** 需要拍板的四类动作。 */
export type TPendingDecisionKind = 'publish' | 'delete' | 'spend' | 'outreach'

/** 四类动作的界面标签，顺序即 BFS-105.1 的原文顺序。 */
export const PENDING_DECISION_KINDS: { kind: TPendingDecisionKind, label: string }[] = [
  { kind: 'publish', label: '发布' },
  { kind: 'delete', label: '删除' },
  { kind: 'spend', label: '花钱' },
  { kind: 'outreach', label: '对外沟通' },
]

/** 当前链路上收不到待办卡的两类：清单为空时据此如实说明原因，而不是含糊过去。 */
export const PENDING_DECISION_KINDS_WITHOUT_SOURCE: TPendingDecisionKind[] = ['delete', 'outreach']

/** 收不到卡片的原因，逐类写清（不含糊、不吓唬）。 */
const WITHOUT_SOURCE_REASONS: Record<string, string> = {
  delete: '内核还没有删除类动作',
  outreach: '评论 / 私信在接待页里处理，不走申请-拍板',
}

/**
 * 把一个动作卡归入四类拍板之一。
 *
 * 归类依据是动作类型本身（`IActionCard.type`，值域见 `store/agent/agent.types.ts`），
 * 不猜文案关键词。
 *
 * @param action - 任务里的动作卡。
 * @returns 四类之一；不属于四类返回 null（不得进待拍板清单）。
 */
export function classifyPendingAction(action: Pick<IActionCard, 'type'>): TPendingDecisionKind | null {
  switch (action.type) {
    case 'navigateToPublish':
      return 'publish'
    case 'insufficientCredits':
      return 'spend'
    default:
      return null
  }
}

export interface IPendingDecisionsProps {
  /** 待拍板条目（页面已按"未回填"筛过；本组件只负责归类与展示）。 */
  items: IPendingDecisionItem[]
  isLoading?: boolean
  /** 扫描范围说明：这份清单看了多少条任务（如实告诉用户边界，不假装是全量）。 */
  scopeNote?: string
  /** 点"去这条任务"时的跳转回调。 */
  onOpenTask?: (taskId: string) => void
  className?: string
}

export function PendingDecisions({ items, isLoading = false, scopeNote, onOpenTask, className }: IPendingDecisionsProps) {
  // 归不到四类的卡片不进清单：其余动作必须自动完成，不该在这里打扰用户（BFS-105.2）。
  const classified = items
    .map(item => ({ item, kind: classifyPendingAction(item.action) }))
    .filter((row): row is { item: IPendingDecisionItem, kind: TPendingDecisionKind } => row.kind !== null)

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <span className="rounded-full border border-border bg-muted px-2 py-0.5">只收四类：发布 / 删除 / 花钱 / 对外沟通</span>
        {scopeNote !== undefined && scopeNote !== '' && <span>{scopeNote}</span>}
      </div>

      {isLoading
        ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在找等你拍板的事…
            </div>
          )
        : classified.length === 0
          ? (
              <div className={cn(cardSurfaceFlat, 'flex flex-col gap-2 p-6')}>
                <p className="text-[15px] text-foreground">当前没有等你拍板的事。</p>
                <p className="text-[13px] text-muted-foreground">
                  四类动作都不会自己往下走：有需要你点头的事，会出现在这里。
                </p>
              </div>
            )
          : (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {classified.map(({ item, kind }) => (
                  <div key={`${item.taskId}-${item.action.requestId ?? item.action.type}`} className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
                        {PENDING_DECISION_KINDS.find(entry => entry.kind === kind)?.label}
                      </span>
                      <AgentRoleBadge agentRole={item.agentRole} />
                      <button
                        type="button"
                        onClick={() => onOpenTask?.(item.taskId)}
                        className="max-w-[240px] cursor-pointer truncate text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        title={item.taskTitle}
                      >
                        来自：{item.taskTitle || '未命名任务'}
                      </button>
                      <span className="text-muted-foreground/80">{formatRelativeTime(new Date(item.updatedAt))}</span>
                    </div>
                    {/* 动作卡的台账必须逐条任务注入：ActionStateRow 按 requestId 在这份台账里查 */}
                    <ActionResultsProvider results={item.actionResults}>
                      <ActionCard action={item.action} taskId={item.taskId} />
                    </ActionResultsProvider>
                  </div>
                ))}
              </div>
            )}

      {/* 四类里当前收不到卡片的那几类：如实说明原因，不含糊成"全都在这里" */}
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          四类里当前收不到卡片的是
          {PENDING_DECISION_KINDS_WITHOUT_SOURCE
            .map(kind => `${PENDING_DECISION_KINDS.find(entry => entry.kind === kind)?.label}（${WITHOUT_SOURCE_REASONS[kind]}）`)
            .join('、')}
          ，所以它们此刻为空——不是被漏掉。
        </span>
      </p>
    </div>
  )
}

export default PendingDecisions
