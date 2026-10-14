import type { getVideoModelsCommonStaticConfig } from '../utils/constants'
import type { DraftContentType, ImageModelPricing, ImageModelType, ImageTextDraftType, VideoDraftType, VideoModelType } from '@web/api/ai/ai.types'
import type { PlatType } from '@web/app/config/platConfig'
import type { IUploadedMedia } from '@web/components/Chat/MediaUpload'
import type { VideoModelParams } from '@web/store/draft-box/draftBoxConfigStore'
import { useCallback } from 'react'
import { toast } from '@web/utils/ui/toast'
import { resolveEffectiveStyle } from '../utils/constants'

type Translate = (key: string, options?: Record<string, number | string | undefined>) => string
type VideoModelConfig = ReturnType<typeof getVideoModelsCommonStaticConfig>

interface BatchGenerationResult {
  success: boolean
  successCount: number
  failedCount: number
  errorMessage?: string
}

interface VideoModelInput {
  modelType: VideoModelType
  resolution?: string
  duration?: number
  aspectRatio?: string
}

interface UseAiBatchSubmitHandlerParams {
  isUploading: boolean
  promptValue: string
  isDraftMode: boolean
  style: string
  captionSystemPrompt: string
  localImages: IUploadedMedia[]
  localVideos: IUploadedMedia[]
  localAudios: IUploadedMedia[]
  contentType: DraftContentType
  selectedImageModels: ImageModelType[]
  selectedVideoModels: VideoModelType[]
  videoModelSelectionMode: 'single' | 'multiple'
  currentImageAspectRatios: string[]
  imagePricing: ImageModelPricing[]
  currentVideoModelConfig: VideoModelConfig
  resolvedVideoModelParams: Record<string, VideoModelParams>
  effectiveQuantity: number
  imageCount: number
  aspectRatio: string
  duration: number
  groupId?: string
  imageSize: string
  effectiveSelectedPlatforms: PlatType[]
  createImageTextBatchGenerationWithModels: (
    quantity: number,
    models: ImageModelType[],
    prompt: string,
    imageCount: number,
    aspectRatio: string,
    imageUrls: string[] | undefined,
    groupId: string | undefined,
    imageSize: string,
    platforms: PlatType[] | undefined,
    mode: ImageTextDraftType,
    captionPrompt: string | undefined,
    style: string,
  ) => Promise<BatchGenerationResult>
  createBatchGenerationWithModels: (
    quantity: number,
    modelInputs: VideoModelInput[],
    duration: number,
    aspectRatio: string,
    prompt: string | undefined,
    imageUrls: string[] | undefined,
    videoUrls: string[] | undefined,
    audioUrls: string[] | undefined,
    groupId: string | undefined,
    platforms: PlatType[] | undefined,
    mode: VideoDraftType,
    captionPrompt: string | undefined,
    style: string,
  ) => Promise<BatchGenerationResult>
  onGenerated?: () => void
  /** 设置里有没有配过模型：没配时要提示"去设置里配置"，而不是"请选择模型"。 */
  hasConfiguredModels: boolean
  t: Translate
}

export function useAiBatchSubmitHandler({
  hasConfiguredModels,
  isUploading,
  promptValue,
  isDraftMode,
  style,
  captionSystemPrompt,
  localImages,
  localVideos,
  localAudios,
  contentType,
  selectedImageModels,
  selectedVideoModels,
  videoModelSelectionMode,
  currentImageAspectRatios,
  imagePricing,
  currentVideoModelConfig,
  resolvedVideoModelParams,
  effectiveQuantity,
  imageCount,
  aspectRatio,
  duration,
  groupId,
  imageSize,
  effectiveSelectedPlatforms,
  createImageTextBatchGenerationWithModels,
  createBatchGenerationWithModels,
  onGenerated,
  t,
}: UseAiBatchSubmitHandlerParams) {
  const handleSubmit = useCallback(async () => {
    // 上传中拦截
    if (isUploading) {
      toast.warning(t('detail.mediaUploading'))
      return
    }

    // 提示词验证
    if (!promptValue.trim()) {
      toast.warning(t('detail.promptRequired'))
      return
    }

    const captionPromptForSubmit = isDraftMode ? captionSystemPrompt.trim() : ''
    // 风格随生成请求下发；未选择时用列表首项，与按钮展示保持一致。
    const styleForSubmit = resolveEffectiveStyle(style, contentType)

    const imageUrls = localImages.filter(m => m.url).map(m => m.url)

    if (contentType === 'image_text') {
      if (selectedImageModels.length === 0) {
        toast.warning(hasConfiguredModels ? t('detail.selectModelRequired') : t('detail.noModelConfigured'))
        return
      }
      if (currentImageAspectRatios.length === 0 || imagePricing.length === 0) {
        toast.warning(t('detail.noCommonModelParams'))
        return
      }

      const result = await createImageTextBatchGenerationWithModels(
        effectiveQuantity,
        selectedImageModels,
        promptValue.trim(),
        imageCount,
        aspectRatio,
        imageUrls.length > 0 ? imageUrls : undefined,
        groupId,
        imageSize,
        effectiveSelectedPlatforms.length > 0 ? effectiveSelectedPlatforms : undefined,
        isDraftMode ? 'draft' : 'image',
        captionPromptForSubmit || undefined,
        styleForSubmit,
      )
      if (result.success) {
        if (result.failedCount > 0) {
          toast.warning(
            t('detail.multiModelPartialSuccess', {
              success: result.successCount,
              failed: result.failedCount,
            }),
          )
        }
        else {
          toast.success(t('detail.imageTextGenerated'))
        }
        onGenerated?.()
      }
      else {
        toast.error(result.errorMessage || t('detail.multiModelGenerateFailed'))
      }
    }
    else {
      if (selectedVideoModels.length === 0) {
        toast.warning(hasConfiguredModels ? t('detail.selectModelRequired') : t('detail.noModelConfigured'))
        return
      }
      // 参考图只有 1 张 + 长档（>12 秒，走分段）时，厂商走 keyframe，会把画面锁在这一张图上：
      // 提示词里的场景、光线、构图不生效（实测：一张人像照 + 217 字场景描述，成片仍是那张照片在动）。
      //
      // **只提示，不拦截**。早先写成"拦住并要求补 3 张"是错的：普通用户手里往往就这一张照片，
      // 而产品**没有**把一张照片变成多角度的能力（图像图生图被厂商静默忽略），
      // 拦下来等于让他做不了事。这里改成"如实告知 + 告诉他做得到的那一步"：
      // 拿手机给同一个人拍正面/侧面/背面三张，是人人都能做、且真的能让场景自由的办法。
      if (imageUrls.length === 1 && duration > 12) {
        toast.warning(
          '⚠️ 只传了 1 张参考图：这条片子会以这张图为主，你写的场景可能画不出来。'
          + '（厂商按参考图数量决定：1 张锁画面，3 张以上才只锁人、场景自由。）'
          + '想两全：拿手机给同一个人拍三张——正面、侧面、背面，一起传上来即可。'
          + '这次先按 1 张继续生成。',
        )
      }
      if (
        videoModelSelectionMode === 'single'
        && currentVideoModelConfig.supportedRatios.size === 0
      ) {
        toast.warning(t('detail.noCommonModelParams'))
        return
      }
      const hasInvalidVideoModelParams = selectedVideoModels.some((model) => {
        const params = resolvedVideoModelParams[model]
        return !params?.aspectRatio || params.duration === undefined
      })
      if (hasInvalidVideoModelParams) {
        toast.warning(t('detail.noCommonModelParams'))
        return
      }

      const videoUrls = localVideos.filter(v => v.url).map(v => v.url)
      const audioUrls = localAudios.filter(a => a.url).map(a => a.url)
      const modelInputs = selectedVideoModels.map(model => ({
        modelType: model,
        resolution: resolvedVideoModelParams[model]?.resolution || undefined,
        duration: resolvedVideoModelParams[model]?.duration,
        aspectRatio: resolvedVideoModelParams[model]?.aspectRatio,
      }))

      const result = await createBatchGenerationWithModels(
        effectiveQuantity,
        modelInputs,
        duration,
        aspectRatio,
        promptValue.trim() || undefined,
        imageUrls.length > 0 ? imageUrls : undefined,
        videoUrls.length > 0 ? videoUrls : undefined,
        audioUrls.length > 0 ? audioUrls : undefined,
        groupId,
        effectiveSelectedPlatforms.length > 0 ? effectiveSelectedPlatforms : undefined,
        isDraftMode ? 'draft' : 'video',
        captionPromptForSubmit || undefined,
        styleForSubmit,
      )
      if (result.success) {
        if (result.failedCount > 0) {
          toast.warning(
            t('detail.multiModelPartialSuccess', {
              success: result.successCount,
              failed: result.failedCount,
            }),
          )
        }
        else {
          toast.success(t('detail.aiBatchGenerate'))
        }
        onGenerated?.()
      }
      else {
        toast.error(result.errorMessage || t('detail.multiModelGenerateFailed'))
      }
    }
  }, [
    promptValue,
    aspectRatio,
    duration,
    localImages,
    localVideos,
    localAudios,
    effectiveQuantity,
    createBatchGenerationWithModels,
    createImageTextBatchGenerationWithModels,
    contentType,
    selectedImageModels,
    selectedVideoModels,
    resolvedVideoModelParams,
    videoModelSelectionMode,
    currentImageAspectRatios.length,
    imagePricing.length,
    currentVideoModelConfig.supportedRatios,
    imageCount,
    isUploading,
    t,
    groupId,
    onGenerated,
    effectiveSelectedPlatforms,
    isDraftMode,
    style,
    captionSystemPrompt,
  ])

  // Prompts 探索页 URL（根据当前模型族切换 grok / seedance 提示词页）

  return handleSubmit
}
