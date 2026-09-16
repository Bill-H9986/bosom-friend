import type { ImageSizeSelectProps } from '../../types'
import { Ruler } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover'
import { cn } from '@web/utils/className'
import { pillClass } from '../../utils/styles'

/**
 * 图片分辨率档位：选项文字与视频档位逐字一致（720p / 1080p），成品像素按当前画面比例
 * 显示在弹层说明行与选项提示里——比例换一次，尺寸说明跟着换，不会混进其它比例的尺寸。
 */
export function ImageSizeSelect({
  imagePricing,
  imageSize,
  label,
  popover,
  onImageSizeChange,
}: ImageSizeSelectProps) {
  const sizeSummary = imagePricing
    .filter(item => (item.size ?? '') !== '')
    .map(item => item.resolution + ' → ' + String(item.size))
    .join(' · ')
  const activeSize = imagePricing.find(item => item.resolution === imageSize)?.size ?? ''

  return (
    <Popover open={popover.open} onOpenChange={popover.onOpenChange}>
      <PopoverTrigger asChild>
        <button data-testid="draftbox-ai-resolution" type="button" className={pillClass} title={activeSize}>
          <Ruler className="h-3.5 w-3.5" />
          {imageSize}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" side="top" align="start">
        <span className="text-xs font-medium text-foreground mb-2 block">{label}</span>
        <div className="flex flex-col gap-1">
          {imagePricing.map(({ resolution, size }) => (
            <button
              key={resolution}
              type="button"
              title={size !== undefined && size !== '' ? resolution + ' · ' + size : resolution}
              className={cn(
                'flex items-center px-3 py-2 rounded-md text-xs cursor-pointer transition-colors text-left',
                resolution === imageSize
                  ? 'bg-primary/10 text-foreground font-medium'
                  : 'hover:bg-muted text-muted-foreground',
              )}
              onClick={() => onImageSizeChange(resolution)}
            >
              {resolution}
            </button>
          ))}
        </div>
        {sizeSummary !== '' && (
          <p className="mt-2 border-t border-border/60 pt-2 text-[10px] leading-4 text-muted-foreground">
            {sizeSummary}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
