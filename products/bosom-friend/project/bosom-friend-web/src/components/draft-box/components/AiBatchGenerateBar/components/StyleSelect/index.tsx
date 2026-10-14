import { Paintbrush } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover'
import { cn } from '@web/utils/className'

export interface StyleSelectProps {
  label: string
  styles: string[]
  /** 已选风格；空串表示用户未选择，此时生成请求使用列表首项（按钮展示的那一项）。 */
  value: string
  onValueChange: (style: string) => void
}

/**
 * 画面风格选择：受控组件，选中项随生成请求下发。
 * 未选择时按钮展示列表首项，该项即实际生效的风格（见 resolveEffectiveStyle）。
 */
export function StyleSelect({
  label,
  styles,
  value,
  onValueChange,
}: StyleSelectProps) {
  const [open, setOpen] = useState(false)
  if (!styles || styles.length === 0)
    return null

  const display = value || styles[0]!

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button data-testid="draftbox-ai-style" type="button" className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-sm transition-colors hover:border-primary/40">
          <Paintbrush className="h-3.5 w-3.5" />
          <span className="tabular-nums">{display}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-3" side="top" align="start">
        <span className="mb-2 block text-xs font-medium text-foreground">{label}</span>
        <div className="grid grid-cols-2 gap-1.5">
          {styles.map(item => {
            const active = display === item
            return (
              <button
                key={item}
                type="button"
                className={cn(
                  'rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer',
                  active
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'hover:bg-accent text-foreground',
                )}
                onClick={() => {
                  onValueChange(item)
                  setOpen(false)
                }}
              >
                {item}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
