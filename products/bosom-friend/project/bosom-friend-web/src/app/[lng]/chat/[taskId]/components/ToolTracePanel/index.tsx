/** ToolTracePanel - 只读的「这一轮调了哪些工具」。缺字段 = 早于 2026-10-12 的旧任务；空数组 = 确实没调过工具（两者不是一回事）。 */
import type { TaskToolTraceEntry } from '@web/api/ai/ai.types'

/**
 * 开关：与 OneSentenceEquivalents 同一个理由（产品负责人 2026-10-13 要求「前端用 0.2.62 那套」）。
 * `false` 时整块不渲染，任务详情页回到 0.2.62 的样子。**数据（task.toolTrace）照常落库**，
 * 只是不显示——将来要开回来只改这一个常量。
 */
const SHOW_TOOL_TRACE = false

export function ToolTracePanel({ trace }: { trace?: TaskToolTraceEntry[] }) {
  if (!SHOW_TOOL_TRACE) return null
  if (trace === undefined || trace.length === 0)
    return <p className="px-1 text-xs text-muted-foreground">{trace === undefined ? '这条任务没有轨迹（早于 2026-10-12）' : '这条任务没有调用工具'}</p>
  const turns = [...new Set(trace.map(e => e.turn))].sort((a, b) => a - b)
  return (
    <section aria-label="工具轨迹" className="max-h-40 overflow-auto rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
      <h3 className="text-sm font-semibold text-foreground">这一轮调了哪些工具</h3>
      {turns.map(turn => (
        <div key={turn} className="mt-1.5">
          <p className="text-xs text-muted-foreground">第 {turn} 轮</p>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {trace.filter(e => e.turn === turn).map((e, i) => (
              <li key={i} className={e.isError ? 'text-xs text-red-600' : 'text-xs text-muted-foreground'}>
                {e.isError ? '失败' : '成功'} · {e.name} · {new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
