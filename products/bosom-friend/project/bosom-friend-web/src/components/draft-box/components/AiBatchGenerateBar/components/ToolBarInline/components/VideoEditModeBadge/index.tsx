import type { VideoEditModeBadgeProps } from '../../types'
import { Video } from 'lucide-react'

export function VideoEditModeBadge({ label }: VideoEditModeBadgeProps) {
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/25">
      <Video className="h-3 w-3" />
      {label}
    </span>
  )
}
