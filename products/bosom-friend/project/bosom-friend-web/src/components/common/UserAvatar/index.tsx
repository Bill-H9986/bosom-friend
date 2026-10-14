/**
 * UserAvatar - 统一用户头像：有头像图片时显示图片，否则显示默认小人图标
 * 内测免登录模式下，用户无自定义头像，统一展示小人剪影。
 */
'use client'

import { UserRound } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@web/components/ui/avatar'
import { getOssUrl } from '@web/utils/oss'
import { cn } from '@web/utils/className'

export interface UserAvatarProps {
  /** 用户昵称（图片 alt 文案） */
  name?: string
  /** 头像 OSS 路径，无则显示小人图标 */
  avatar?: string
  /** 尺寸/样式类，默认 h-8 w-8 */
  className?: string
}

export function UserAvatar({ name, avatar, className }: UserAvatarProps) {
  return (
    <Avatar className={cn('shrink-0 border border-border', className)}>
      <AvatarImage src={getOssUrl(avatar) || ''} alt={name || '用户'} />
      <AvatarFallback className="bg-gradient-to-br from-brand-purple to-brand-cyan text-white">
        <UserRound className="h-[55%] w-[55%]" strokeWidth={2.2} />
      </AvatarFallback>
    </Avatar>
  )
}