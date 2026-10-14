/**
 * AgentAssetsHeader - AI 生成素材页顶部组件
 * 桌面端精简版：仅保留统计信息，标题由全局顶栏展示（去除冗余返回按钮与重复标题）
 */

'use client'

import { Bot } from 'lucide-react'
import { useTransClient } from '@web/app/i18n/client'

interface AgentAssetsHeaderProps {
  /** 总数量 */
  total: number
}

export function AgentAssetsHeader({ total }: AgentAssetsHeaderProps) {
  const { t } = useTransClient('material')

  return (
    <div className="flex items-center gap-2 px-1 pt-1">
      <div className="w-7 h-7 rounded-lg bg-gradient-back text-gradient-foreground flex items-center justify-center">
        <Bot className="w-3.5 h-3.5" />
      </div>
      <span className="text-sm text-muted-foreground">
        {t('agentAssets.title')}
        {total > 0 ? `（${total}）` : ''}
      </span>
    </div>
  )
}
