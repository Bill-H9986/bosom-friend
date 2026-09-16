/**
 * 全站统一卡片样式
 *
 * 所有卡片（任务/媒体/素材/热点/频道/指标/草稿等）共用同一套
 * 圆角、边框、背景、阴影与悬停动效，保证全 APP 视觉与交互一致。
 *
 * - cardSurface     ：卡片容器（圆角/边框/阴影/悬停上浮）
 * - cardSurfaceFlat ：无需图片裁切时的平铺变体（内边距由调用方控制）
 * - cardImageZoom   ：卡片内图片/封面悬停放大
 */
export const cardSurface =
  'group relative overflow-hidden rounded-xl border border-border/60 bg-card transition-all duration-300 ease-apple-out hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-xl hover:shadow-primary/10'

export const cardSurfaceFlat =
  'group rounded-xl border border-border/60 bg-card transition-all duration-300 ease-apple-out hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-xl hover:shadow-primary/10'

export const cardImageZoom = 'transition-transform duration-300 group-hover:scale-105'
