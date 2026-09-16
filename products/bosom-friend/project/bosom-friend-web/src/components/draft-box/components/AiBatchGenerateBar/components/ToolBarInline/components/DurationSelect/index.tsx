import type { DurationSelectProps } from '../../types'
import { Clock, Lock } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover'
import { Slider } from '@web/components/ui/slider'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { cn } from '@web/utils/className'
import { pillClass } from '../../utils/styles'

import { DEFAULT_VIDEO_DURATION_SECONDS, SHORT_VIDEO_MAX_SECONDS } from '../../../../utils/constants'

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
  const enabledDurationOptions = durationOptions ?? []
  // 兜底：持久化数据可能含旧版非法档位；显示时收敛到本板块的默认档位（超长短视频的档位在来源处已过滤）。
  const currentDuration = draftDuration ?? duration
  const effectiveDuration = enabledDurationOptions.length > 0 && !enabledDurationOptions.includes(currentDuration)
    ? (enabledDurationOptions.find(option => option === DEFAULT_VIDEO_DURATION_SECONDS) ?? enabledDurationOptions[0])
    : currentDuration

  if (isVideoEditMode && inputVideoDuration !== null) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={cn(pillClass, 'opacity-50 pointer-events-none')}>
              <Lock className="h-3 w-3" />
              <Clock className="h-3.5 w-3.5" />
              <span className="tabular-nums">{formatDuration(duration)}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{lockedByVideoLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  if (videoDurationLimits.min === videoDurationLimits.max) {
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
                        {formatDuration(seconds)}
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
        </div>
      </PopoverContent>
    </Popover>
  )
}
