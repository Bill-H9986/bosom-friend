/**
 * CostBar - 用量与成本条（ADR-005 呈现层改造方案 v1.0 的 N7）。
 *
 * 数据源只有一条：`GET v2/usage/summary?days=N`（服务端 `routes-content.ts` 的用量概览）。
 * 它给的是**调用次数与耗时**，来自知识库的蒸馏账本——每条样本就是一次真实模型调用。
 *
 * ## 口径纪律（写死在界面上，不靠使用者自觉）
 *
 * 1. **tokens 恒为 null**：产品不记录 token 数（内核没有回传用量）。界面上必须写「未记录」，
 *    **绝不许显示 0**——0 会被读成"这次调用没消耗 token"，是编出来的数字。
 *    同理，**不许**拿 `contextChars` / 输出字符数乘系数估算：那是把估算值伪装成实测值。
 * 2. 接口返回失败或没有数据时显示**未采集**，不显示 0。
 * 3. 次数与耗时**不能当费用使用**——接口自己带了 `tokensNote`，这里原样展示给用户看。
 *
 * 展示四块：近 N 天调用次数 / 总耗时 / 模型分布（含平均耗时）/ 按天趋势（柱状）。
 */
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@web/components/ui/button'
import { cardSurfaceFlat } from '@web/utils/card'
import { cn } from '@web/utils/className'
import http from '@web/utils/request'

/** 观察窗口：近 7 天。方案 S5 与 BFS-202.1 都按「今日累计」这类短窗口给数。 */
export const USAGE_WINDOW_DAYS = 7

/** 单个模型的用量分布。 */
export interface IUsageByModel {
  /** 模型名（服务端取不到时给「未知」，界面原样显示，不替它改名）。 */
  model: string
  /** 该模型在这个窗口里的调用次数。 */
  count: number
  /** 该模型在这段时间里的平均单次耗时（毫秒）。 */
  avgMs: number
}

/** 单日用量。 */
export interface IUsageByDay {
  /** 本地日期，形如 2026-10-11。 */
  date: string
  count: number
  totalMs: number
}

/** `GET v2/usage/summary` 的响应体。 */
export interface IUsageSummary {
  /** 服务端实际采用的窗口天数（会被夹在 1~90）。 */
  days: number
  /** 窗口内的模型调用次数。 */
  calls: number
  /** 窗口内的累计耗时（毫秒）。 */
  totalMs: number
  byModel: IUsageByModel[]
  byDay: IUsageByDay[]
  /** 产品不记录 token：服务端恒给 null。界面据此显示「未记录」，不显示 0。 */
  tokens: null
  /** 服务端给的口径说明，原样展示。 */
  tokensNote: string
}

/** 毫秒转人话：不足 1 秒给毫秒，不足 1 分给秒，再往上给分秒。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0)
    return '0 毫秒'
  if (ms < 1000)
    return `${Math.round(ms)} 毫秒`
  if (ms < 60000)
    return `${(ms / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

/** `2026-10-11` → `10-11`（柱状图轴上的短标签）。 */
function shortDate(date: string): string {
  return date.length >= 10 ? date.slice(5) : date
}

/** 取一条响应里的数据；拿不到就返回 null（调用方据此显示「未采集」）。 */
function dataOf<T>(res: { code: string | number, data?: T } | null): T | null {
  if (res === null || res.code !== 0 || res.data === undefined || res.data === null)
    return null
  return res.data
}

export interface CostBarProps {
  /** 额外类名（外层间距由调用方给，避免同一页出现两套外边距）。 */
  className?: string
}

/**
 * 用量条：近 N 天的调用次数、总耗时、模型分布与按天趋势。
 *
 * @param props.className - 外层附加类名。
 */
export function CostBar({ className }: CostBarProps) {
  const [summary, setSummary] = useState<IUsageSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    setIsLoading(true)
    setLoadFailed(false)
    try {
      const res = await http.get<IUsageSummary>('v2/usage/summary', { days: String(USAGE_WINDOW_DAYS) })
      const data = dataOf(res)
      if (data === null) {
        setSummary(null)
        setLoadFailed(true)
        return
      }
      setSummary(data)
    }
    catch {
      // 读不到用量就说读不到，界面显示「未采集」；不拿 0 顶替（0 会被读成"这段时间没调用过"）。
      setSummary(null)
      setLoadFailed(true)
    }
    finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 柱状图的基准：窗口内单日最大调用次数。全 0 时给 1，避免除零。 */
  const peakCount = useMemo(() => {
    const counts = (summary?.byDay ?? []).map(day => day.count)
    return counts.length === 0 ? 1 : Math.max(1, ...counts)
  }, [summary])

  const windowLabel = `近 ${summary?.days ?? USAGE_WINDOW_DAYS} 天`
  const hasCalls = summary !== null && summary.calls > 0

  return (
    <section className={cn(cardSurfaceFlat, 'flex flex-col gap-6 p-6', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">用量与成本</h2>
        <span className="text-[13px] text-muted-foreground">
          {windowLabel}
          的模型调用次数与耗时
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto cursor-pointer gap-2"
          onClick={() => void load()}
          disabled={isLoading}
        >
          <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          刷新
        </Button>
      </div>

      {/* 概览：调用次数 / 总耗时 / token 数 */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="flex flex-col gap-2 rounded-2xl border border-border p-6">
          <span className="text-[13px] text-muted-foreground">调用次数</span>
          <span className="text-[28px] font-semibold leading-none text-foreground">
            {summary === null ? (isLoading ? '读取中…' : '未采集') : summary.calls}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {summary === null
              ? '没有读到用量接口，不显示 0 顶替'
              : '来自知识库蒸馏账本，每条样本是一次真实模型调用'}
          </span>
        </div>

        <div className="flex flex-col gap-2 rounded-2xl border border-border p-6">
          <span className="text-[13px] text-muted-foreground">总耗时</span>
          <span className="text-[28px] font-semibold leading-none text-foreground">
            {summary === null ? (isLoading ? '读取中…' : '未采集') : formatDuration(summary.totalMs)}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {summary === null
              ? '同上，拿不到就不给数字'
              : `${summary.calls} 次调用的耗时合计`}
          </span>
        </div>

        <div className="flex flex-col gap-2 rounded-2xl border border-border p-6">
          <span className="text-[13px] text-muted-foreground">Token 数</span>
          {/* 关键口径：产品不记录 token 数。这里永远是「未记录」，不是 0，也不是估算值。 */}
          <span className="text-[28px] font-semibold leading-none text-foreground">未记录</span>
          <span className="text-[13px] text-muted-foreground">
            {summary?.tokensNote ?? '产品当前不记录 token 数（内核未回传用量），不能用估算值顶替'}
          </span>
        </div>
      </div>

      {loadFailed && (
        <p className="text-[13px] text-destructive">
          用量接口没读出来，上面显示「未采集」。点「刷新」再试一次。
        </p>
      )}

      {/* 模型分布 */}
      <div className="flex flex-col gap-3">
        <h3 className="text-[17px] font-medium text-foreground">模型分布</h3>
        {summary === null
          ? (
              <p className="text-[13px] text-muted-foreground">
                {isLoading ? '正在读用量…' : '未采集：没有读到用量接口。'}
              </p>
            )
          : summary.byModel.length === 0
            ? (
                <p className="text-[13px] text-muted-foreground">
                  这
                  {' '}
                  {windowLabel}
                  还没有模型调用记录。
                </p>
              )
            : (
                <ul className="flex flex-col gap-3">
                  {summary.byModel.map(item => (
                    <li
                      key={item.model}
                      className="flex flex-wrap items-center gap-3 rounded-2xl border border-border px-6 py-3"
                    >
                      <span className="min-w-0 flex-1 truncate text-[15px] text-foreground" title={item.model}>
                        {item.model}
                      </span>
                      <span className="text-[15px] text-foreground">
                        {item.count}
                        {' '}
                        次
                      </span>
                      <span className="text-[13px] text-muted-foreground">
                        平均
                        {' '}
                        {formatDuration(item.avgMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
      </div>

      {/* 按天趋势（柱状） */}
      <div className="flex flex-col gap-3">
        <h3 className="text-[17px] font-medium text-foreground">按天趋势</h3>
        {summary === null
          ? (
              <p className="text-[13px] text-muted-foreground">
                {isLoading ? '正在读用量…' : '未采集：没有读到用量接口。'}
              </p>
            )
          : !hasCalls || summary.byDay.length === 0
            ? (
                <p className="text-[13px] text-muted-foreground">
                  这
                  {' '}
                  {windowLabel}
                  还没有调用，所以没有柱子。没有调用的日期不会补一根 0 高柱。
                </p>
              )
            : (
                <div className="flex items-end gap-3 overflow-x-auto pb-1">
                  {summary.byDay.map(day => (
                    <div key={day.date} className="flex w-16 shrink-0 flex-col items-center gap-2">
                      <span className="text-[13px] text-muted-foreground">{day.count}</span>
                      <div
                        className="w-8 rounded-t-xl bg-primary transition-all duration-200 ease-apple-out"
                        style={{ height: `${Math.max(4, Math.round((day.count / peakCount) * 96))}px` }}
                        title={`${day.date}：${day.count} 次，耗时 ${formatDuration(day.totalMs)}`}
                      />
                      <span className="text-[13px] text-muted-foreground">{shortDate(day.date)}</span>
                    </div>
                  ))}
                </div>
              )}
        {summary !== null && hasCalls && (
          <p className="text-[13px] text-muted-foreground">
            只画有调用的日期；柱高按窗口内单日最大次数归一。
          </p>
        )}
      </div>

      <p className="text-[13px] text-muted-foreground">
        口径：这里是调用「次数」与「耗时」，不是费用。产品不记录 token 数，所以没有任何金额换算，
        也不能拿它当账单使用。
      </p>
    </section>
  )
}

export default CostBar
