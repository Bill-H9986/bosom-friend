import type { DurationSelectProps } from '../../types'
import { useEffect, useState } from 'react'
import { Clock, Lock } from 'lucide-react'
import { apiVideoQuota } from '@web/api/ai/ai.api'
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover'
import { Slider } from '@web/components/ui/slider'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { cn } from '@web/utils/className'
import { pillClass } from '../../utils/styles'

import { DEFAULT_VIDEO_DURATION_SECONDS, SHORT_VIDEO_MAX_SECONDS, durationPillState, isComposedVideoDuration } from '../../../../utils/constants'

/** 将秒数格式化为中文时长：60 秒显示为「1 分钟」，180 秒显示为「3 分钟」 */
function formatDuration(seconds: number): string {
  if (seconds > 0 && seconds % 60 === 0) {
    return `${seconds / 60} 分钟`
  }
  return `${seconds} 秒`
}

export function DurationSelect({
  draftDuration,
  duration,
  durationOptions,
  inputVideoDuration,
  isVideoEditMode,
  label,
  lockedByVideoLabel,
  popover,
  videoDurationLimits,
  onDurationCommit,
  onDurationDraftChange,
}: DurationSelectProps) {
  // 今日额度：厂商没有查询接口，这里显示的是**本机任务记录**的累计（后端算好口径）。
  // 用户看不见额度就会一头撞上 429：官方免费档每天 500 秒、每分钟真正执行 1 次。
  const [quota, setQuota] = useState<{ usedSecondsToday: number, dailyQuotaSeconds: number, remainingSeconds: number } | null>(null)
  useEffect(() => {
    let alive = true
    void apiVideoQuota().then(res => {
      if (alive && res?.code === 0 && res.data !== undefined) setQuota(res.data)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  const enabledDurationOptions = durationOptions ?? []
  // 兜底：持久化数据可能含旧版非法档位；显示时收敛到本板块的默认档位（超长短视频的档位在来源处已过滤）。
  // 拼装档位（30/60）不参与这层收敛——它们本来就不在模型的 durations 列表里，收敛会把用户的选择显示成默认档。
  const currentDuration = draftDuration ?? duration
  const effectiveDuration = enabledDurationOptions.length > 0
    && !enabledDurationOptions.includes(currentDuration)
    && !isComposedVideoDuration(currentDuration)
    ? (enabledDurationOptions.find(option => option === DEFAULT_VIDEO_DURATION_SECONDS) ?? enabledDurationOptions[0])
    : currentDuration

  // 只读药丸显示的是**真正会提交的那个时长**（inputVideoDuration），不是本地档位 state：
  // 提交链路按 `inputVideoDuration ?? duration` 取值，两者一旦不同，用户看到的和下单的就不是同一件事
  // （实测 2026-09-19 DEF-112：药丸显示 30 秒，服务端收到 5 秒）。判定见 `durationPillState`。
  const pillState = durationPillState({
    isVideoEditMode,
    inputVideoDuration,
    limitMin: videoDurationLimits.min,
    limitMax: videoDurationLimits.max,
  })
  if (pillState === 'locked-by-video' && inputVideoDuration !== null) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              data-testid="draftbox-ai-duration"
              type="button"
              aria-disabled="true"
              className={cn(pillClass, 'opacity-50 pointer-events-none')}
            >
              <Lock className="h-3 w-3" />
              <Clock className="h-3.5 w-3.5" />
              <span className="tabular-nums">{formatDuration(inputVideoDuration)}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{lockedByVideoLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  if (pillState === 'fixed') {
    return (
      <span className={cn(pillClass, 'opacity-50 pointer-events-none')}>
        <Lock className="h-3 w-3" />
        <Clock className="h-3.5 w-3.5" />
        <span className="tabular-nums">{formatDuration(duration)}</span>
      </span>
    )
  }

  return (
    <Popover open={popover.open} onOpenChange={popover.onOpenChange}>
      <PopoverTrigger asChild>
        <button data-testid="draftbox-ai-duration" type="button" className={pillClass}>
          <Clock className="h-3.5 w-3.5" />
          <span className="tabular-nums">{formatDuration(effectiveDuration)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className={durationOptions && durationOptions.length > 0 ? 'w-52 p-3' : 'w-48 p-3'} side="top" align="start">
        <div className="space-y-2">
          <span className="text-xs font-medium text-foreground">{label}</span>
          {durationOptions && durationOptions.length > 0
            ? (
                <div className="grid grid-cols-2 gap-1.5">
                  {durationOptions.map((seconds) => {
                    const active = effectiveDuration === seconds
                    // 耗时预告：厂商免费档视频模型**每分钟只真正执行 1 个镜头**（官方 RPM），
                    // 而每片最多 4 秒，所以「片数 ≈ 秒数 ÷ 4」基本就是「至少要等几分钟」。
                    // 后端有更准的 longDurationEstimates（按实测延迟算），但要一路透传 props；
                    // 这里给出量级正确的下限，目的只有一个：让用户知道**这不是卡住了**。
                    const clips = Math.max(1, Math.ceil(seconds / 4))
                    const hint = clips <= 1 ? '' : String(clips) + ' 片 · 至少 ' + String(clips) + ' 分钟'
                    return (
                      <button
                        key={seconds}
                        type="button"
                        onClick={() => onDurationCommit([seconds])}
                        className={cn(
                          'cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                          active
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'bg-muted text-foreground/80 hover:bg-primary/10 hover:text-primary',
                        )}
                      >
                        <span className="block">{formatDuration(seconds)}</span>
                        {hint === '' ? null : <span className="block text-[10px] font-normal opacity-70">{hint}</span>}
                      </button>
                    )
                  })}
                </div>
              )
            : (
                <div className="flex items-center gap-2">
                  <Slider
                    value={[draftDuration ?? duration]}
                    onValueChange={onDurationDraftChange}
                    onValueCommit={onDurationCommit}
                    min={videoDurationLimits.min}
                    // 模型允许更长也不越过本板块上限：短视频这一档就是短视频。
                    max={Math.min(videoDurationLimits.max, SHORT_VIDEO_MAX_SECONDS)}
                    step={1}
                    className="flex-1"
                  />
                  <span className="text-xs text-muted-foreground w-8 text-right">
                    {formatDuration(effectiveDuration)}
                  </span>
                </div>
              )}
          {quota === null
            ? null
            : (
                <p className="text-[11px] leading-4 text-muted-foreground">
                  今日已用 {quota.usedSecondsToday} 秒 / {quota.dailyQuotaSeconds} 秒（本机记录口径），剩 {quota.remainingSeconds} 秒
                </p>
              )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
