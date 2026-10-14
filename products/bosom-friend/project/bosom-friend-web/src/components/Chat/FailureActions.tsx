/**
 * FailureActions - 失败态的三个出口（BFS-104.4 / 方案 M8）
 *
 * 为什么必须是三个，而不是一个「重试」：
 * 失败的原因不同，用户想要的东西就不同——
 * - 断点继续：已经跑成的部分不该白花（分段出片最典型），接着往下跑；
 * - 重新生成：这一次的结果不要了，按同样的要求从头再来；
 * - 放弃：不办了，把这条失败记录收起来。
 * 此前多数失败点只有一句"请重新生成"或干脆没有出口（用户口径："什么也做不了"）。
 *
 * **复用**：本组件只负责渲染与回调透出；三个动作各自怎么实现由调用方决定
 * （草稿箱生成卡里是长视频续跑接口，对话里是 store 的 continueTask / createTask），
 * 所以它不 import 任何业务接口——一个失败态出口组件不该顺带把出片链路带进每个页面。
 */

'use client'

import { Ban, RefreshCw, RotateCcw } from 'lucide-react'
import { cn } from '@web/utils/className'

export interface IFailureActionsProps {
  /** 断点继续：只补没跑成的部分；不传则不显示这个按钮。 */
  onContinue?: () => void
  /** 重新生成：按原参数/原话重新来一遍。 */
  onRegenerate?: () => void
  /** 放弃：收起这条失败。 */
  onAbandon?: () => void
  /** 某个动作正在进行（按钮置灰，避免连点）。 */
  busy?: boolean
  /** 三个按钮的对齐方式：靠左（列表里）或居中（卡片底栏）。 */
  align?: 'start' | 'center'
  className?: string
}

/**
 * @param props - 三个动作回调与排版选项；回调都不传时不渲染任何按钮。
 * @returns 失败态出口按钮组。
 */
export function FailureActions({
  onContinue,
  onRegenerate,
  onAbandon,
  busy = false,
  align = 'start',
  className,
}: IFailureActionsProps) {
  if (onContinue === undefined && onRegenerate === undefined && onAbandon === undefined)
    return null

  const buttonClass = cn(
    'inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground',
    'transition-colors duration-200 ease-apple hover:border-brand-cyan/50 hover:bg-brand-cyan/10 hover:text-brand-purple-deep',
    'disabled:cursor-not-allowed disabled:opacity-50',
  )

  return (
    <div
      data-testid="failure-actions"
      className={cn(
        'flex flex-wrap items-center gap-2',
        align === 'center' ? 'justify-center' : 'justify-start',
        className,
      )}
    >
      {onContinue !== undefined && (
        <button
          type="button"
          disabled={busy}
          data-testid="failure-action-continue"
          className={buttonClass}
          onClick={onContinue}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          断点继续
        </button>
      )}
      {onRegenerate !== undefined && (
        <button
          type="button"
          disabled={busy}
          data-testid="failure-action-regenerate"
          className={buttonClass}
          onClick={onRegenerate}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重新生成
        </button>
      )}
      {onAbandon !== undefined && (
        <button
          type="button"
          disabled={busy}
          data-testid="failure-action-abandon"
          className={cn(buttonClass, 'text-muted-foreground hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive')}
          onClick={onAbandon}
        >
          <Ban className="h-3.5 w-3.5" />
          放弃
        </button>
      )}
    </div>
  )
}

export default FailureActions
