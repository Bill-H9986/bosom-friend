/**
 * DigitalHumanDialog - 数字人形象管理（创作页内弹窗）
 *
 * 为什么是弹窗而不是一个页面：形象只有一个归属——"这条视频用哪张脸"，
 * 它是创作流程里的一步（选形象 → 填提示词 → 生成），不是一个独立的板块。
 * 内容复用 {@link DigitalHumansPage} 的 embedded 形态，功能一处实现、两处不漂移。
 */
'use client'

import { X } from 'lucide-react'
import DigitalHumansPage from '@web/desktop-pages/DigitalHumansPage'
import { Button } from '@web/components/ui/button'

export interface DigitalHumanDialogProps {
  /** 是否打开。 */
  open: boolean
  /** 关闭回调。 */
  onClose: () => void
}

export function DigitalHumanDialog({ open, onClose }: DigitalHumanDialogProps) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4"
      data-testid="digital-human-dialog"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-4xl overflow-auto rounded-2xl border bg-card p-4 shadow-xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">数字人形象</h3>
          <Button variant="ghost" size="sm" data-testid="digital-human-dialog-close" onClick={onClose}>
            <X className="mr-1 h-3.5 w-3.5" />关闭
          </Button>
        </div>
        <DigitalHumansPage embedded />
      </div>
    </div>
  )
}
