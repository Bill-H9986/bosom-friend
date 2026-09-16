/**
 * ToolBarInline - 内联工具栏
 * 组合生成模式、平台、模型参数、比例时长、数量、快捷链接和提交控件。
 */

'use client'

import type { ToolBarInlineProps } from './types'
import { memo, useMemo } from 'react'
import { StyleSelect } from '../StyleSelect'
import { Send } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@web/app/i18n/client'
import { useAccountStore } from '@web/store/account'
import { openPublishDialog } from '@web/store/publishDialogHost'
import { useAiBatchGenerateBarLocalState } from '../../store'
import PlatformSelector from '../PlatformSelector'
import { AspectRatioSelect } from './components/AspectRatioSelect'
import { CreditsSubmitControl } from './components/CreditsSubmitControl'
import { DurationSelect } from './components/DurationSelect'
import { GenerationModeSelect } from './components/GenerationModeSelect'
import { ImageCountSelect } from './components/ImageCountSelect'
import { ImageSizeSelect } from './components/ImageSizeSelect'
import { ModelSelect } from './components/ModelSelect'
import { MoreOptionsToggle } from './components/MoreOptionsToggle'
import { QuantitySelect } from './components/QuantitySelect'
import { VideoEditModeBadge } from './components/VideoEditModeBadge'
import { VideoModelParamsSelect } from './components/VideoModelParamsSelect'
import { VideoResolutionSelect } from './components/VideoResolutionSelect'
import { IMAGE_STYLE_OPTIONS, VIDEO_STYLE_OPTIONS } from '../../utils/constants'
import { useClickPopover } from './hooks/useClickPopover'
import { Button } from '@web/components/ui/button'
import { useToolBarActions } from './hooks/useToolBarActions'
import { useToolBarDerivedData } from './hooks/useToolBarDerivedData'
import { useToolBarDraftValues } from './hooks/useToolBarDraftValues'
import { pillClass } from './utils/styles'

const ToolBarInline = memo(
  ({
    configKey,
    fallbackState,
    imageAspectRatios,
    imageModelOptions,
    imagePricing,
    videoModels,
    videoAspectRatios,
    videoResolutions,
    videoModelOptions,
    resolvedVideoModelParams,
    videoDurationLimits,
    isVideoEditMode,
    inputVideoDuration,
    isLoading,
    promptsExploreUrl,
    promptsExploreLabel,
    hideNonDraftModes = false,
    effectiveLimitsDetailed,
    disabledPlatforms,
    actions,
  }: ToolBarInlineProps) => {
    const { t } = useTransClient(['brandPromotion', 'route'])

    const {
      contentType,
      selectedVideoModels,
      videoModelSelectionMode,
      aspectRatio,
      duration,
      resolution,
      quantity,
      selectedImageModels,
      imageModelSelectionMode,
      imageCount,
      imageSize,
      isDraftMode,
      selectedPlatforms,
      moreOptionsOpen,
      style,
    } = useAiBatchGenerateBarLocalState(configKey, fallbackState)

    const {
      onDraftModeChange,
      onContentTypeChange,
      onVideoModelsChange,
      onVideoModelSelectionModeChange,
      onVideoModelParamChange,
      onResolutionChange,
      onAspectRatioChange,
      onDurationChange,
      onQuantityChange,
      onImageModelsChange,
      onImageModelSelectionModeChange,
      onImageCountChange,
      onImageSizeChange,
      onPlatformsChange,
      onMoreOptionsChange,
      onStyleChange,
      onSubmit,
    } = actions

    const imageCountLabel = isDraftMode
      ? t('detail.imageTextDraftImageCount')
      : t('detail.imageCount')

    const {
      currentModelDisplay,
      isTimeLimitedModel,
      isVideoMode,
      isVideoMultiSelect,
      modelOptionsCount,
      selectedModelValues,
      selectedVideoModelParamInfos,
      supportedRatios,
    } = useToolBarDerivedData({
      contentType,
      duration,
      imageAspectRatios,
      imageModelOptions,
      inputVideoDuration,
      isVideoEditMode,
      selectedImageModels,
      selectedVideoModels,
      selectModelsLabel: t('detail.selectModels'),
      videoAspectRatios,
      videoModelOptions,
      videoModelParams: resolvedVideoModelParams,
      videoModels,
      videoModelSelectionMode,
      videoResolutions,
    })

    // 视频时长档位：优先使用模型 durations（如 3/5/10/60/180 秒）
    const durationOptions = useMemo(() => {
      if (!isVideoMode || isVideoMultiSelect) {
        return []
      }
      const options = selectedVideoModels.flatMap((name) => {
        const model = videoModels?.find(item => item.name === name)
        return model?.durations ?? []
      })
      return [...new Set(options)].sort((a, b) => a - b)
    }, [isVideoMode, isVideoMultiSelect, selectedVideoModels, videoModels])

    const {
      handleImageCountChange,
      handleImageModelToggle,
      handleQuantityChange,
      handleVideoModelToggle,
    } = useToolBarActions({
      imageModelSelectionMode,
      onImageCountChange,
      onImageModelsChange,
      onQuantityChange,
      onVideoModelsChange,
      selectedImageModels,
      selectedVideoModels,
      videoModelSelectionMode,
    })

    const {
      draftDuration,
      draftVideoModelDurations,
      handleDurationCommit,
      handleDurationDraftChange,
      handleVideoModelDurationCommit,
      handleVideoModelDurationDraftChange,
    } = useToolBarDraftValues({
      duration,
      onDurationChange,
      onVideoModelParamChange,
    })

    const { accountGroupList, accountList } = useAccountStore(useShallow(state => ({ accountGroupList: state.accountGroupList, accountList: state.accountList })))
    const publishAccounts = useMemo(() => {
      const grouped = accountGroupList.reduce<typeof accountList>((acc, g) => [...acc, ...g.children], [])
      return grouped.length > 0 ? grouped : accountList
    }, [accountGroupList, accountList])

    const genModePopover = useClickPopover()
    const modelPopover = useClickPopover()
    const ratioPopover = useClickPopover()
    const durationPopover = useClickPopover()
    const quantityPopover = useClickPopover()
    const imageSizePopover = useClickPopover()
    const videoResolutionPopover = useClickPopover()
    const videoParamsPopover = useClickPopover()
    const imageCountPopover = useClickPopover()

    return (
      <div className="flex items-center gap-2 flex-wrap">
        {isVideoEditMode && <VideoEditModeBadge label={t('detail.videoEditMode')} />}

        <GenerationModeSelect
          contentType={contentType}
          hideNonDraftModes={hideNonDraftModes}
          isDraftMode={isDraftMode}
          isVideoMode={isVideoMode}
          labels={{
            contentTypeImageText: t('detail.contentTypeImageText'),
            contentTypeVideo: t('detail.contentTypeVideo'),
            draftModeOffImage: t('detail.draftModeOffImage'),
            draftModeOffVideo: t('detail.draftModeOffVideo'),
            draftModeOn: t('detail.draftModeOn'),
          }}
          popover={genModePopover}
          onContentTypeChange={onContentTypeChange}
          onDraftModeChange={onDraftModeChange}
        />

        {isDraftMode && (
          <PlatformSelector
            selectedPlatforms={selectedPlatforms}
            onPlatformsChange={onPlatformsChange}
            pillClass={pillClass}
            disabledPlatforms={disabledPlatforms}
            effectiveLimitsDetailed={effectiveLimitsDetailed}
          />
        )}

        <ModelSelect
          currentModelDisplay={currentModelDisplay}
          imageModelOptions={imageModelOptions}
          imageModelSelectionMode={imageModelSelectionMode}
          isTimeLimitedModel={isTimeLimitedModel}
          isVideoMode={isVideoMode}
          labels={{
            imageModel: t('detail.imageModel'),
            modelType: t('detail.modelType'),
            multiSelect: t('detail.multiSelect'),
            selectedModelsCount: values => t('detail.selectedModelsCount', values),
            singleSelect: t('detail.singleSelect'),
            timeLimitedModelTip: t('detail.timeLimitedModelTip'),
          }}
          modelOptionsCount={modelOptionsCount}
          popover={modelPopover}
          selectedImageModels={selectedImageModels}
          selectedModelValues={selectedModelValues}
          selectedVideoModels={selectedVideoModels}
          videoModelOptions={videoModelOptions}
          videoModelSelectionMode={videoModelSelectionMode}
          videoModels={videoModels}
          onImageModelSelectionModeChange={onImageModelSelectionModeChange}
          onImageModelToggle={handleImageModelToggle}
          onVideoModelSelectionModeChange={onVideoModelSelectionModeChange}
          onVideoModelToggle={handleVideoModelToggle}
        />

        {isVideoMultiSelect && (
          <VideoModelParamsSelect
            draftVideoModelDurations={draftVideoModelDurations}
            isVideoEditMode={isVideoEditMode}
            labels={{
              aspectRatio: t('detail.aspectRatio'),
              duration: t('detail.duration'),
              videoModelParams: t('detail.videoModelParams'),
              videoResolution: t('detail.videoResolution'),
            }}
            popover={videoParamsPopover}
            selectedVideoModelParamInfos={selectedVideoModelParamInfos}
            videoModelOptions={videoModelOptions}
            onVideoModelDurationCommit={handleVideoModelDurationCommit}
            onVideoModelDurationDraftChange={handleVideoModelDurationDraftChange}
            onVideoModelParamChange={onVideoModelParamChange}
          />
        )}

        {!isVideoMode && imagePricing.length > 0 && (
          <ImageSizeSelect
            imagePricing={imagePricing.filter(p => !p.aspectRatio || p.aspectRatio === aspectRatio)}
            imageSize={imageSize}
            label={t('detail.imageResolution')}
            popover={imageSizePopover}
            onImageSizeChange={onImageSizeChange}
          />
        )}

        {isVideoMode && !isVideoMultiSelect && videoResolutions.length > 0 && (
          <VideoResolutionSelect
            label={t('detail.videoResolution')}
            popover={videoResolutionPopover}
            resolution={resolution}
            videoResolutions={videoResolutions}
            onResolutionChange={onResolutionChange}
          />
        )}

        <StyleSelect
          label={isVideoMode ? '视频风格' : '图片风格'}
          styles={isVideoMode ? VIDEO_STYLE_OPTIONS : IMAGE_STYLE_OPTIONS}
          value={style}
          onValueChange={onStyleChange}
        />

        {!isVideoMultiSelect && (
          <AspectRatioSelect
            aspectRatio={aspectRatio}
            isLocked={isVideoEditMode}
            label={t('detail.aspectRatio')}
            lockedLabel={t('detail.ratioLockedByVideo')}
            popover={ratioPopover}
            supportedRatios={supportedRatios}
            onAspectRatioChange={onAspectRatioChange}
          />
        )}

        {isVideoMode && !isVideoMultiSelect && (
          <DurationSelect
            draftDuration={draftDuration}
            duration={duration}
            durationOptions={durationOptions}
            inputVideoDuration={inputVideoDuration}
            isVideoEditMode={isVideoEditMode}
            label={t('detail.duration')}
            lockedByVideoLabel={t('detail.durationLockedByVideo')}
            popover={durationPopover}
            videoDurationLimits={videoDurationLimits}
            onDurationCommit={handleDurationCommit}
            onDurationDraftChange={handleDurationDraftChange}
          />
        )}

        {!isVideoMode && (
          <ImageCountSelect
            imageCount={imageCount}
            label={imageCountLabel}
            popover={imageCountPopover}
            onImageCountChange={handleImageCountChange}
          />
        )}

        {(isVideoMode || isDraftMode) && (
          <QuantitySelect
            label={isDraftMode ? t('detail.draftQuantity') : t('detail.quantity')}
            popover={quantityPopover}
            quantity={quantity}
            onQuantityChange={handleQuantityChange}
          />
        )}

        {isDraftMode && (
          <MoreOptionsToggle
            label={t('detail.moreOptions')}
            open={moreOptionsOpen}
            onOpenChange={onMoreOptionsChange}
          />
        )}

        <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => openPublishDialog({ accounts: publishAccounts, autoCloseOnComplete: true })}
          >
            <Send className="h-4 w-4" />
            <span>一键发布</span>
          </Button>
          <CreditsSubmitControl
            isLoading={isLoading}
            onSubmit={onSubmit}
          />
        </div>
      </div>
    )
  },
)

ToolBarInline.displayName = 'ToolBarInline'

export default ToolBarInline
