/**
 * MediaAddToReferenceAction - 图片资源追加到 AI 参考文件
 * 在纯图片资源卡片上提供一键追加到 AI 批量生成输入参考文件的入口
 */

'use client'

import type { MediaItem } from '@web/api/materials/material.types'
import { ImagePlus } from 'lucide-react'
import { memo, useCallback } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import { Button } from '@web/components/ui/button'
import { useDraftBoxConfigStore } from '@web/store/draft-box/draftBoxConfigStore'
import { cn } from '@web/utils/className'
import { getOssUrl } from '@web/utils/oss'
import { toast } from '@web/utils/ui/toast'

interface MediaAddToReferenceActionProps {
  media: MediaItem
  groupId: string
  maxImages: number
}

export const MediaAddToReferenceAction = memo(({
  media,
  groupId,
  maxImages,
}: MediaAddToReferenceActionProps) => {
  const { t } = useTransClient('brandPromotion')

  const handleAddToReference = useCallback(() => {
    if (media.type !== 'img') {
      return
    }

    const { getConfig, appendPersistedMedias } = useDraftBoxConfigStore.getState()
    const currentConfig = getConfig(groupId)
    const persistedImageUrls = (currentConfig.persistedMedias ?? [])
      .filter(item => item.type === 'image')
      .map(item => getOssUrl(item.url))
    const currentImageCount = persistedImageUrls.length
    const normalizedUrl = getOssUrl(media.url)

    if (persistedImageUrls.includes(normalizedUrl)) {
      toast.info(t('detail.draftImagesAlreadyInReference'))
      return
    }

    const availableCount = Math.max(0, maxImages - currentImageCount)
    if (availableCount === 0) {
      toast.warning(t('detail.imageCountExceeded', { max: maxImages }))
      return
    }

    const { added } = appendPersistedMedias(groupId, [{
      id: `media-reference-${media._id}`,
      url: normalizedUrl,
      type: 'image',
      name: media.title || undefined,
    }])

    if (added === 0) {
      toast.info(t('detail.draftImagesAlreadyInReference'))
      return
    }

    toast.success(t('detail.draftImagesAddedToReference', { count: added }))
  }, [groupId, maxImages, media, t])

  if (media.type !== 'img') {
    return null
  }

  return (
    <Button
      type="button"
      onClick={handleAddToReference}
      className={cn(
        'group/add-ref h-8 max-w-full cursor-pointer rounded-full border border-transparent bg-gradient-back pl-1.5 pr-3 text-gradient-foreground !shadow-[0_6px_20px_rgba(139,92,246,0.28)]',
        'gap-1.5 transition-all duration-200 ease-apple-out',
        'hover:border-transparent hover:!shadow-[0_8px_28px_rgba(139,92,246,0.38)] hover:-translate-y-px',
        'active:scale-95 active:!shadow-[0_3px_10px_rgba(139,92,246,0.24)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1',
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-white/25 text-white transition-transform duration-200 group-hover/add-ref:scale-110">
        <ImagePlus className="size-3" />
      </span>
      <span className="truncate text-xs font-medium text-gradient-foreground">{t('detail.addDraftImagesToReference')}</span>
    </Button>
  )
})

MediaAddToReferenceAction.displayName = 'MediaAddToReferenceAction'
