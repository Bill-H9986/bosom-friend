'use client'

import { ExternalLink } from 'lucide-react'
import { useTransClient } from '@web/app/i18n/client'
import { cn } from '@web/utils/className'
import { formatNumber } from '@web/utils/format'
import type { HotContentFeedItem } from '../api'

function formatHeatText(value: string) {
  let prefixLength = 0
  while (prefixLength < value.length) {
    const char = value[prefixLength]
    if (!((char >= '0' && char <= '9') || char === ',' || char === '.'))
      break
    prefixLength += 1
  }
  if (prefixLength === 0)
    return value
  const numberPart = value.slice(0, prefixLength)
  const suffix = value.slice(prefixLength)
  if (/^[kw万亿]/i.test(suffix) || /^[-/年月]/.test(suffix))
    return value
  const parsed = Number(numberPart.replaceAll(',', ''))
  return Number.isFinite(parsed) ? `${formatNumber(parsed)}${suffix}` : value
}

interface HotContentRankedListProps {
  sourceKey: string
  items: HotContentFeedItem[]
  compact?: boolean
}

export function HotContentRankedList({ sourceKey, items, compact = false }: HotContentRankedListProps) {
  const { ready, t } = useTransClient('hotContent')

  if (!ready)
    return null

  return (
    <ol
      className="divide-y divide-border"
      data-testid={`hot-content-ranked-list-${sourceKey}`}
    >
      {items.map(({ description, heatText, rank, targetUrl, title }) => (
        <li
          key={`${rank}-${title}`}
          className={cn(
            'group/item flex items-center gap-3',
            compact ? 'py-2.5' : 'py-4',
          )}
        >
          <span
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-bold leading-none tabular-nums',
              rank <= 3
                ? 'bg-gradient-to-br from-[#8B7CF6] to-[#B79CFF] text-white shadow-sm'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {rank}
          </span>
          <div className="min-w-0 flex-1">
            {targetUrl
              ? (
                  <a
                    data-testid={`hot-content-item-link-${sourceKey}-${rank}`}
                    href={targetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative z-10 flex min-w-0 cursor-pointer items-center gap-1.5 text-sm font-medium leading-5 text-foreground outline-none transition-colors hover:text-primary focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span title={title} className={cn(compact && 'min-w-0 flex-1 truncate')}>
                      {title}
                    </span>
                    <ExternalLink className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/item:opacity-60 group-focus-within/item:opacity-60" />
                    <span className="sr-only">{t('feed.openExternal')}</span>
                  </a>
                )
              : (
                  <p
                    title={title}
                    className={cn(
                      'text-sm font-medium leading-5 text-foreground',
                      compact && 'truncate',
                    )}
                  >
                    {title}
                  </p>
                )}
            {!compact && description && (
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {heatText && (
            <span
              title={heatText}
              className="max-w-24 shrink-0 truncate text-right text-xs tabular-nums text-muted-foreground"
            >
              {formatHeatText(heatText)}
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}
