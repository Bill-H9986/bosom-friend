/**
 * LogoSection - 侧边栏 Logo 区域（左侧导航栏与右侧 AI 助手面板共用）
 * 左侧展开态：图标在上、字标在下，整体水平居中；折叠按钮绝对定位右上角。
 * 右侧展开态：面板空间宝贵，用紧凑头部（32px logo + AI 助手 + 同款 32px 收起钮）。
 * 收起态（两侧一致）：logo 居中，hover 侧栏时 logo 淡出、展开按钮原位浮现（同一位置交替，视觉无重叠）。
 * side='right' 仅切换朝向图标与 data-testid。
 */

'use client'

import type { LogoSectionProps } from '../types'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import Image from '@web/next-shims/image'
import Link from '@web/next-shims/link'
import { BRAND_TITLE, BrandWordmark } from '@web/app/layout/shared'
import logo from '@web/assets/images/logo.png'

const SIDE_BUTTON_CLASSNAME =
  'app-no-drag flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-transparent text-brand-cyan transition-colors hover:bg-brand-cyan/10 hover:text-brand-cyan'

export function LogoSection({ collapsed, onToggle, side = 'left' }: LogoSectionProps) {
  const CloseIcon = side === 'right' ? PanelRightClose : PanelLeftClose
  const OpenIcon = side === 'right' ? PanelRightOpen : PanelLeftOpen
  const testid = side === 'left' ? 'sidebar-toggle-btn' : (collapsed ? 'ai-assistant-expand-btn' : 'ai-assistant-collapse-btn')

  // 右侧展开态：紧凑头部（面板空间宝贵，不放品牌大 Logo）
  if (side === 'right' && !collapsed) {
    return (
      <div className="app-drag-region mb-3 flex items-center justify-between px-1 py-2">
        <span className="app-no-drag flex items-center gap-2 text-foreground no-underline" data-testid="ai-assistant-compact-logo">
          <Image src={logo} alt="AI 助手" width={32} height={32} />
          <span className="text-base font-semibold tracking-tight">AI 助手</span>
        </span>
        <button onClick={onToggle} aria-label={side === 'right' ? (collapsed ? '展开 AI 助手' : '收起 AI 助手') : (collapsed ? '展开侧边栏' : '收起侧边栏')} className={SIDE_BUTTON_CLASSNAME} data-testid={testid}>
          <CloseIcon size={16} />
        </button>
      </div>
    )
  }

  if (collapsed) {
    return (
      <div className="app-drag-region relative mb-3 flex items-center justify-center px-1 py-2">
        {/* 收起态：logo 居中常显；hover 侧栏时淡出 */}
        <Link
          href="/"
          className="app-no-drag flex items-center justify-center transition-opacity duration-300 group-hover:opacity-0"
          data-testid="sidebar-logo-link"
        >
          <Image src={logo} alt={BRAND_TITLE} width={36} height={36} />
        </Link>
        {/* 收起态：展开按钮与 logo 同一位置（重叠替代），仅 hover 时浮现 */}
        <button
          onClick={onToggle}
          aria-label={side === 'left' ? '展开侧边栏' : '展开 AI 助手'}
          className={
            'pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-300 group-hover:pointer-events-auto group-hover:opacity-100 '
            + SIDE_BUTTON_CLASSNAME
          }
          data-testid={testid}
        >
          <OpenIcon size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="app-drag-region relative mb-3 flex items-center justify-center px-2 py-3">
      {/* 展开态：图标上、字标下，整体在侧栏内水平居中 */}
      <Link
        href="/"
        className="app-no-drag group/logo flex flex-col items-center gap-1.5 text-foreground no-underline hover:opacity-85"
        data-testid="sidebar-logo-link"
      >
        <Image src={logo} alt={BRAND_TITLE} width={56} height={56} />
        <BrandWordmark as={side === 'right' ? 'span' : 'h1'} size="sidebar" />
      </Link>

      {/* 展开态：折叠按钮绝对定位右上角，不挤占 logo 居中空间 */}
      <button
        onClick={onToggle}
        aria-label={side === 'right' ? '收起 AI 助手' : '收起侧边栏'}
        className={'absolute top-1.5 right-1.5 ' + SIDE_BUTTON_CLASSNAME}
        data-testid={testid}
      >
        <CloseIcon size={16} />
      </button>
    </div>
  )
}
