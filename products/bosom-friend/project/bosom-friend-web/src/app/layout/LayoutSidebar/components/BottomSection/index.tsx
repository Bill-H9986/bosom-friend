/**
 * BottomSection - 底部功能区容器
 * 开源版仅保留浏览器插件入口。
 */

'use client'

import type { BottomSectionProps } from '../../types'
import { PluginEntry } from './PluginEntry'

export function BottomSection(_props: BottomSectionProps) {
  // 开源版移除浏览器插件入口（插件依赖外部扩展，且未安装时会产生报错提示）
  return null
  /*
  return (
    <div
      className={cn(
        'flex flex-col gap-1 border-t border-sidebar-border pt-3',
        collapsed && 'items-center',
      )}
    >
      <PluginEntry collapsed={collapsed} />
    </div>
  )
  */
}

export { PluginEntry } from './PluginEntry'
