/**
 * DraftCard - 草稿卡片（小红书风格）
 * 封面保持原始比例，支持批量模式圆形勾选与拖拽到发布弹框
 *
 * 两种呈现规格（合并前分别由草稿页签与全部页签各自实现）：
 * - detail：草稿页签。展示账号平台图标与使用次数徽标，根节点带 draftbox-draft-card 定位，
 *   批量模式下带选中过渡动画，标题/封面替代文案有兜底
 * - compact：全部页签混合列表。与 MediaCard 一致的极简卡片，封面走 OSS 缩略图，
 *   标题/封面替代文案不兜底
 */

'use client'

import type { PromotionMaterial } from '@web/api/materials/material.types'
import type { PlatType } from '@web/app/config/platConfig'
import { resolveAsset } from '@web/utils/assetPath'
import { Check } from 'lucide-react'
import { memo, useCallback } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import { OssImage } from '@web/components/common/OssImage'
import { getPlatformInfoSync } from '@web/store/platformMetadata'
import { cn } from '@web/utils/className'
import { LazyImage } from '../LazyImage'
import { PublishDialogDragSource } from '../PublishDialogDragSource'

export type DraftCardVariant = 'detail' | 'compact'

interface DraftCardProps {
  material: PromotionMaterial
  onClick: () => void
  batchMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  /** 使用次数徽标，草稿页签计算后传入 */
  useCountLabels?: string[]
  /** 卡片呈现规格 */
  variant?: DraftCardVariant
  enablePublishDrag?: boolean
}

const DRAFT_CARD_VARIANTS = {
  detail: {
    testId: 'draftbox-draft-card',
    checkboxTestId: 'draftbox-draft-checkbox',
    showPlatformIcons: true,
    useOssThumbnail: false,
  },
  compact: {
    testId: undefined,
    checkboxTestId: undefined,
    showPlatformIcons: false,
    useOssThumbnail: true,
  },
} as const

const DraftCard = memo(({
  material,
  onClick,
  batchMode,
  selected,
  onToggleSelect,
  useCountLabels = [],
  variant = 'detail',
  enablePublishDrag,
}: DraftCardProps) => {
  const { t } = useTransClient('brandPromotion')
  const coverUrl = material.coverUrl || resolveAsset('images/placeholder.png')
  const canPublishDrag = !!enablePublishDrag && !batchMode
  const variantConfig = DRAFT_CARD_VARIANTS[variant]
  const emptyTitle = variant === 'detail' ? t('material.untitled') : ''
  const emptyCoverAlt = variant === 'detail' ? t('material.draft') : ''

  const handleClick = useCallback(() => {
    if (batchMode) {
      onToggleSelect?.()
    }
    else {
      onClick()
    }
  }, [batchMode, onClick, onToggleSelect])

  const cardNode = (
    <div
      data-testid={variantConfig.testId}
      className={variant === 'detail'
        ? cn(
            'mb-4 cursor-pointer group relative',
            batchMode
              ? cn(
                  'rounded-xl transition-all duration-200',
                  selected ? 'shadow-lg' : '',
                )
              : '',
          )
        : cn(
            'mb-4 cursor-pointer group relative',
            batchMode && selected && 'rounded-xl shadow-lg',
          )}
      onClick={handleClick}
    >
      {/* 批量模式圆形勾选指示器 */}
      {batchMode && (
        <div
          data-testid={variantConfig.checkboxTestId}
          className={cn(
            'absolute top-2 right-2 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all duration-200 shadow-sm',
            selected
              ? 'border-transparent bg-gradient-back scale-110'
              : 'bg-background/90 border-muted-foreground/30 group-hover:border-primary group-hover:scale-105',
          )}
          onClick={(e) => { e.stopPropagation(); onToggleSelect?.() }}
        >
          {selected && <Check className="w-3.5 h-3.5 text-gradient-foreground" />}
        </div>
      )}

      {/* 封面图 - 保持原始比例，圆角独立 */}
      <div className="relative w-full overflow-hidden rounded-xl">
        <LazyImage
          src={coverUrl}
          alt={material.title || emptyCoverAlt}
          width={400}
          height={300}
          className="w-full h-auto transition-transform duration-300 group-hover:scale-105"
          skeletonClassName="rounded-xl"
          placeholderHeight={150}
          style={{ aspectRatio: 'auto' }}
          useOssThumbnail={variantConfig.useOssThumbnail}
        />

        {/* hover 时显示描述遮罩 - 批量模式下隐藏 */}
        {!batchMode && material.desc && (
          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-3 rounded-xl">
            <p className="text-white text-xs line-clamp-4">
              {material.desc}
            </p>
          </div>
        )}

        {/* 选中遮罩 */}
        {batchMode && selected && (
          <div className="absolute inset-0 bg-primary/15 pointer-events-none rounded-xl" />
        )}
      </div>
      {/* 标题和模型标签 */}
      <div className="pt-2 px-1">
        <p className="text-sm font-medium text-foreground line-clamp-2">
          {material.title || emptyTitle}
        </p>
        {material.model && (
          <span className="inline-block mt-1 px-1.5 py-0.5 text-xs rounded bg-muted text-muted-foreground">
            {material.model}
          </span>
        )}
        {useCountLabels.map(label => (
          <span
            key={label}
            className="inline-block mt-1 ml-1 px-1.5 py-0.5 text-xs rounded bg-primary/10 text-primary"
          >
            {label}
          </span>
        ))}
        {variantConfig.showPlatformIcons && material.accountTypes && material.accountTypes.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {material.accountTypes.map((type) => {
              const platInfo = getPlatformInfoSync(type as PlatType)
              if (!platInfo)
                return null
              return (
                <OssImage
                  key={type}
                  src={platInfo.icon}
                  alt={platInfo.name}
                  width={16}
                  height={16}
                  className="w-4 h-4"
                  unoptimized
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )

  if (!canPublishDrag)
    return cardNode

  return (
    <PublishDialogDragSource dragItem={{ kind: 'draft', material }}>
      {cardNode}
    </PublishDialogDragSource>
  )
})

DraftCard.displayName = 'DraftCard'

export { DraftCard }
