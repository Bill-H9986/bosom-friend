/**
 * AgentCard - 管家卡（ADR-005 呈现层改造方案 v1.0 的 N2）。
 *
 * 一张卡回答"这个管家是谁、能干什么、现在手上有什么"：
 * 身份（中文名走 `AGENT_ROLE_LABELS`，不另编名字）+ 工具面摘要（事实源见 `../roles.ts`）
 * + 在办任务数 + 最近一次动作。
 *
 * 没有在办任务时如实显示"暂无在办"——**不拿别的管家的任务顶上，也不造一条假任务**；
 * 任务上的 `agentRole` 为 null（旧任务未登记归属）不塞进任何一个管家。
 */
'use client'

import type { ITeamAgentTaskItem } from '../types'
import { Bot, Clock3 } from 'lucide-react'
import { AgentRoleBadge } from '@web/components/Chat/AgentRoleBadge'
import { cn } from '@web/utils/className'
import { cardSurfaceFlat } from '@web/utils/card'
import { formatRelativeTime } from '@web/utils/format'
import type { ITeamAgentRole } from '../roles'

export interface ITeamAgentCardProps {
  /** 管家事实（代号 / 职责 / 工具面），来自 `TEAM_AGENT_ROLES`。 */
  role: ITeamAgentRole
  /** 该管家当前在办的任务；空数组 = 暂无在办。 */
  activeTasks: ITeamAgentTaskItem[]
  /** 该管家最近更新的一条任务（不限状态），用于"最近一次动作"；没有则显示"还没有办过事"。 */
  latestTask?: ITeamAgentTaskItem
  /** 当前在时间线上选中的任务 id。 */
  selectedTaskId?: string
  /** 点某条在办任务：把它交给时间线。 */
  onSelectTask?: (taskId: string) => void
}

/** 任务状态 → 人话标签；未登记的状态按原样显示（宁可露原名，也不编一个可能对不上的说法）。 */
function statusLabel(status?: string): string {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'running':
      return '进行中'
    case 'requires_action':
      return '等你拍板'
    case 'completed':
      return '已完成'
    case 'error':
      return '失败'
    case 'aborted':
      return '已中止'
    default:
      return status ?? ''
  }
}

/** 在办状态的颜色档：一眼看出哪张卡上有活、哪张卡卡住了。 */
function statusClass(status?: string): string {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'running':
      return 'border-blue-200 bg-blue-50 text-blue-700'
    case 'requires_action':
      return 'border-amber-200 bg-amber-50 text-amber-700'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

export function AgentCard({ role, activeTasks, latestTask, selectedTaskId, onSelectTask }: ITeamAgentCardProps) {
  return (
    <div className={cn(cardSurfaceFlat, 'flex flex-col gap-4 p-6')}>
      {/* 身份 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Bot className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <AgentRoleBadge agentRole={role.code} className="mb-0.5" />
            <p className="truncate text-xs text-muted-foreground">{role.duty}</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
          在办
          {' '}
          {activeTasks.length}
        </span>
      </div>

      {/* 工具面摘要：这个管家能做什么（工具面即权限边界） */}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">能做什么</p>
        <div className="flex flex-wrap gap-2">
          {role.toolSurface.map(item => (
            <span
              key={item.pattern}
              title={item.pattern}
              className="rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground/80"
            >
              {item.label}
            </span>
          ))}
        </div>
      </div>

      {/* 在办任务 */}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">在办任务</p>
        {activeTasks.length === 0
          ? <p className="text-xs text-muted-foreground">暂无在办</p>
          : (
              <ul className="flex flex-col gap-2">
                {activeTasks.map(task => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => onSelectTask?.(task.id)}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors',
                        task.id === selectedTaskId
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border bg-background hover:bg-muted/60',
                      )}
                    >
                      <span className="truncate text-xs text-foreground" title={task.title}>
                        {task.title || '未命名任务'}
                      </span>
                      <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px]', statusClass(task.status))}>
                        {statusLabel(task.status)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
      </div>

      {/* 最近一次动作 */}
      <p className="mt-auto flex items-center gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        <Clock3 className="h-3 w-3 shrink-0" />
        {latestTask
          ? (
              <span className="truncate" title={latestTask.title}>
                最近一次：
                {latestTask.title || '未命名任务'}
                {' · '}
                {formatRelativeTime(new Date(latestTask.updatedAt || latestTask.createdAt))}
                {statusLabel(latestTask.status) === '' ? '' : ` · ${statusLabel(latestTask.status)}`}
              </span>
            )
          : <span>还没有办过事</span>}
      </p>
    </div>
  )
}

export default AgentCard
