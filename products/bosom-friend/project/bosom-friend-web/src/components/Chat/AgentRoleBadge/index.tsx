/**
 * AgentRoleBadge - 归属管家小标签。
 *
 * 任务卡与任务详情共用它回答"这条任务是谁在办的"（ADR-005 呈现层改造方案 v1.0 的 S1）。
 * `agentRole` 为空 = 未登记（旧任务）：显示"未登记"，不拿总管顶替。
 */
import { UserRound } from 'lucide-react'
import { AGENT_ROLE_UNREGISTERED, agentRoleLabel } from '@web/components/Chat/utils/agentRoles'
import { cn } from '@web/utils/className'

export interface IAgentRoleBadgeProps {
  /** 任务上的归属管家；`null` 或缺失表示未登记。 */
  agentRole?: string | null
  /** 自定义类名。 */
  className?: string
}

export function AgentRoleBadge({ agentRole, className }: IAgentRoleBadgeProps) {
  const label = agentRoleLabel(agentRole)
  const unregistered = label === null

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium shrink-0',
        unregistered
          ? 'border-border bg-muted/50 text-muted-foreground'
          : 'border-border bg-muted text-foreground',
        className,
      )}
      title={unregistered ? '未登记归属管家' : `归属：${label}`}
    >
      <UserRound className="w-3 h-3" />
      <span>{unregistered ? AGENT_ROLE_UNREGISTERED : label}</span>
    </span>
  )
}

export default AgentRoleBadge
