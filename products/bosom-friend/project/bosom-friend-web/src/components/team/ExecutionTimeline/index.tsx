/**
 * ExecutionTimeline - 执行时间线（ADR-005 呈现层改造方案 v1.0 的 N3）。
 *
 * 回答"干到哪、卡在哪"：把一条任务的 `IWorkflowStep[]`（thinking / tool_call / tool_result
 * 三态，见 `store/agent/agent.types.ts`）按发生顺序画出来，工具名一律走共享标签表
 * `toolDisplayName`（"查平台账号"比 `bosom_platform_list_accounts` 有用）。
 *
 * 失败态是这条时间线存在的理由（方案 R4：团队页不许变成"任务列表换皮"）：
 * 工具结果里带错误标记时标红并说明"这一步失败了"，不把失败画成成功。
 */
'use client'

import type { IWorkflowStep } from '@web/store/agent'
import { Brain, CircleAlert, CircleCheck, ClipboardList, Loader2, Wrench } from 'lucide-react'
import { toolDisplayName } from '@web/components/Chat/utils/toolLabels'
import { cn } from '@web/utils/className'

export interface IExecutionTimelineProps {
  /** 这条任务的步骤流（按时间正序）。 */
  steps: IWorkflowStep[]
  /** 正在加载该任务的过程。 */
  isLoading?: boolean
  /** 没有步骤时的说明文案。 */
  emptyText?: string
  /** 追加类名。 */
  className?: string
}

/**
 * 工具结果是不是失败。
 *
 * 内核把工具错误包在结果文本里（`is_error`），`IWorkflowStep` 上没有独立的错误位，
 * 所以这里只认两种**能确证**的写法；认不出来就算成功——宁可漏报，也不把正常结果标成失败。
 *
 * @param result - 工具结果原文。
 * @returns 判定为失败返回 true。
 */
export function isFailedToolResult(result?: string): boolean {
  const raw = (result ?? '').trim()
  if (raw === '') return false
  if (/"is_error"\s*:\s*true/i.test(raw)) return true
  if (/^error(:|\b)/i.test(raw)) return true
  return false
}

/** 步骤类型 → 人话标签。 */
function stepKindLabel(step: IWorkflowStep): string {
  switch (step.type) {
    case 'thinking':
      return '思考'
    case 'tool_call':
      return '调用工具'
    case 'tool_result':
      return '工具结果'
    default:
      return ''
  }
}

/** 把长文本压成一行摘要。 */
function summarize(text: string | undefined, limit = 160): string {
  const raw = (text ?? '').replace(/\s+/g, ' ').trim()
  if (raw.length <= limit) return raw
  return `${raw.slice(0, limit)}…`
}

/** 单个步骤。 */
function StepRow({ step }: { step: IWorkflowStep }) {
  const failed = isFailedToolResult(step.result)
  const done = step.type === 'tool_call' ? step.result !== undefined : !step.isActive
  const name = step.type === 'tool_call' || step.type === 'tool_result'
    ? toolDisplayName(step.toolName || '')
    : stepKindLabel(step)

  return (
    <li className="flex items-start gap-2 rounded-lg bg-muted/60 px-2 py-1.5">
      <span className="mt-0.5 shrink-0">
        {step.isActive
          ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          : failed
            ? <CircleAlert className="h-3.5 w-3.5 text-destructive" />
            : done
              ? <CircleCheck className="h-3.5 w-3.5 text-success" />
              : step.type === 'thinking'
                ? <Brain className="h-3.5 w-3.5 text-muted-foreground/70" />
                : step.type === 'tool_result'
                  ? <ClipboardList className="h-3.5 w-3.5 text-muted-foreground/70" />
                  : <Wrench className="h-3.5 w-3.5 text-muted-foreground/70" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-xs font-medium', failed ? 'text-destructive' : 'text-foreground')}>
          {step.type === 'thinking' ? '思考' : name}
          {step.type === 'tool_call' && step.result === undefined && !step.isActive ? '（等待结果）' : ''}
          {failed ? '（这一步失败了）' : ''}
        </p>
        {summarize(step.content) !== '' && (
          <p className="mt-0.5 break-all text-[11px] text-muted-foreground">{summarize(step.content)}</p>
        )}
        {summarize(step.result) !== '' && (
          <p className={cn('mt-0.5 break-all text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground/80')}>
            {summarize(step.result)}
          </p>
        )}
      </div>
      <span className="shrink-0 text-[10px] text-muted-foreground/70">
        {step.isActive ? '进行中' : stepKindLabel(step)}
      </span>
    </li>
  )
}

export function ExecutionTimeline({ steps, isLoading = false, emptyText = '这条任务还没有可看的步骤', className }: IExecutionTimelineProps) {
  if (isLoading) {
    return (
      <div className={cn('flex items-center gap-2 text-[13px] text-muted-foreground', className)}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在读这条任务的过程…
      </div>
    )
  }

  if (steps.length === 0) {
    return <p className={cn('text-[13px] text-muted-foreground', className)}>{emptyText}</p>
  }

  return (
    <ol className={cn('flex flex-col gap-2', className)}>
      {steps.map((step, index) => (
        <StepRow key={step.id || index} step={step} />
      ))}
    </ol>
  )
}

export default ExecutionTimeline
