/**
 * VideoCard 组件
 * 展示自动播放的示例视频卡片（对齐官网：默认静音循环播放，点击进入详情）
 */
'use client'

import type { VideoCardProps } from '../types'
import { memo, useEffect, useRef } from 'react'
import { cn } from '@web/utils/className'
import { resolveAsset } from '@web/utils/assetPath'

export const VideoCard = memo(({ item, onClick, size = 'horizontal' }: VideoCardProps) => {
  const videoRef = useRef<HTMLVideoElement>(null)

  // 进入视口后播放，离开视口立即暂停：避免三个大视频同时拉流并在页面切换时产生中断请求。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const start = () => {
      if (!video.paused)
        return
      void video.play().catch(() => {})
    }
    const stop = () => {
      video.pause()
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting)
          start()
        else
          stop()
      }
    }, { threshold: 0.15 })
    observer.observe(video)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible')
        start()
      else
        stop()
    })
    return () => {
      observer.disconnect()
      stop()
    }
  }, [])

  return (
    <div
      className={cn(
        'group relative cursor-pointer overflow-hidden rounded-xl border border-border/60 bg-card',
        'transition-all duration-300 ease-apple-out',
        'hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-xl hover:shadow-primary/10',
        'dark:hover:shadow-black/30',
        // 根据 size 设置不同的高度
        size === 'vertical' ? 'h-full' : '',
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      {/* 视频预览：静音循环自动播放，封面作为海报占位 */}
      <div
        className={cn(
          'relative w-full overflow-hidden',
          // 竖视频使用全高度，横视频使用 16:9 比例
          size === 'vertical' ? 'h-full' : 'aspect-video',
        )}
      >
        <video
          ref={videoRef}
          src={resolveAsset(item.video)}
          poster={resolveAsset(item.cover)}
          muted
          loop
          playsInline
          preload="none"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />

        {/* 底部标题遮罩 */}
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 p-3',
            'bg-gradient-to-t from-black/70 to-transparent',
          )}
        >
          <h3
            className={cn(
              'line-clamp-2 text-sm font-medium text-white',
              'transition-colors duration-200',
            )}
          >
            {item.title}
          </h3>
        </div>
      </div>
    </div>
  )
})
