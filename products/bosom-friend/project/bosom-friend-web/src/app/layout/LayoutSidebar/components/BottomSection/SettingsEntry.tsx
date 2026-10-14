/**
 * SettingsEntry - 设置入口（侧边栏底部功能区）
 *
 * 为什么在这里：陌生人找"设置"，第一反应是**左下角的功能区**（桌面软件的通用习惯，
 * 「添加频道」「关于本产品」已经在这里），不是"看板"里的某张卡——看板是**看数据**的地方，
 * 设置不属于它。首屏右上角只有一枚「手工发布」，把齿轮塞进去会与它抢同一块注意力，
 * 与 BFS-900《界面设计规范 v1.0》906.7「首屏的视觉中心必须是对话输入框」相冲。
 *
 * 为什么是路由不是弹窗：用户菜单里的「设置」仍是弹窗（快速改常用项），
 * 这里指向已存在的 `#/settings` 页（四个标签：通用设置 / 自定义大模型 / 远程访问 / 系统与更新），
 * 复用旧路由、不改路由表、不改 routerData 的导航收敛结果。
 *
 * 与同一组另外两项同一套写法：左对齐、8px 图标间距、收缩态居中并出右侧提示。
 */

'use client'

import type { SidebarCommonProps } from '../../types'
import { Settings } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@web/components/ui/tooltip'
import { cn } from '@web/utils/className'

export function SettingsEntry({ collapsed }: SidebarCommonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href="#/settings"
            className={cn(
              'flex w-full cursor-pointer items-center rounded-lg text-muted-foreground transition-colors duration-200 ease-apple-out hover:bg-accent hover:text-foreground',
              collapsed ? 'h-9 justify-center' : 'gap-2 px-3 py-2',
            )}
          >
            <Settings size={18} />
            {!collapsed && <span className="text-sm">设置</span>}
          </a>
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right">
            <p>设置</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  )
}
