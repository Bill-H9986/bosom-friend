/**
 * BottomSection - 底部功能区容器
 * 浏览器插件入口保持移除；这里承载「添加频道」「管家团队」「设置」。
 *
 * 2026-10-12 恢复旧导航：一级导航回到旧的 7 项（内容创作 / 任务记录 / 发布日历 /
 * 数据中心 / 全局监控 / AI互动 / 知识库），「管家团队」不再占一级位置，改为底部
 * 低频入口，与「添加频道 / 设置」同组。「关于本产品」去掉——首屏本身就是那一页
 * （`/about` 已重定向到 `/`），留着就是同一个目的地两个入口。
 */

'use client'

import type { BottomSectionProps } from '../../types'
import { cn } from '@web/utils/className'
import { AccountEntry } from './AccountEntry'
import { PluginEntry } from './PluginEntry'

/**
 * 底部功能组：添加频道 / 管家团队 / 设置。
 *
 * 三项都是"入口"，属于**同一组**，所以组内只有统一的 12px 间距、没有分隔线——
 * 分隔线留给「功能组 ↔ 用户身份区」这条真正的层级边界（见 LayoutSidebar）。
 * 主导航项的数量与名字不在这里决定（全部来自 routerData）。
 */
export function BottomSection({ collapsed }: BottomSectionProps) {
  // 浏览器插件入口保持移除（插件依赖外部扩展，未安装时会产生报错提示）。
  return (
    <div
      className={cn(
        'flex flex-col gap-3',
        collapsed && 'items-center',
      )}
    >
      {/* 添加频道：频道管理弹窗入口 */}
      <AccountEntry collapsed={collapsed} />
    </div>
  )
}

export { PluginEntry } from './PluginEntry'
