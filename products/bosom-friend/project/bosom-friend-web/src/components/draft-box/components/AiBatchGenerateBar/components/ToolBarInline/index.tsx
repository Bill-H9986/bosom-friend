/**
 * ToolBarInline - 内联工具栏
 * 组合生成模式、平台、模型参数、比例时长、数量、快捷链接和提交控件。
 */

'use client'

import type { ToolBarInlineProps } from './types'
import { memo, useMemo, useState } from 'react'
import { StyleSelect } from '../StyleSelect'
import { Send, UserRound } from 'lucide-react'
import { DigitalHumanDialog } from '../../../DigitalHumanDialog'
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
import { IMAGE_STYLE_OPTIONS, VIDEO_STYLE_OPTIONS, getEnabledVideoDurations } from '../../utils/constants'
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
    /** 形象管理弹窗（数字人功能已并入本页）。 */
    const [humanDialogOpen, setHumanDialogOpen] = useState(false)

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
      noModelLabel: t('detail.noModel'),
      selectModelsLabel: t('detail.selectModels'),
      videoAspectRatios,
      videoModelOptions,
      videoModelParams: resolvedVideoModelParams,
      videoModels,
      videoModelSelectionMode,
      videoResolutions,
    })

    // 视频时长档位：模型的全部可选档位 = 原生 durations（如 4/5/6/8/10/12 秒）
    // + 多片段拼装档位（30 秒 / 1 分钟）。两者必须一起列出：只列 durations 时，用户在模型
    // 参数面板里选的 30 秒在这个选择器里不存在，会被 sanitize 成默认档，看起来"选了没生效"。
    const durationOptions = useMemo(() => {
      if (!isVideoMode || isVideoMultiSelect) {
        return []
      }
      const selected = (videoModels ?? []).filter(model => selectedVideoModels.includes(model.name))
      return getEnabledVideoDurations(selected)
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
            noModelConfigured: t('detail.noModelConfigured'),
            goConfigureModel: t('detail.goConfigureModel'),
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
            lockedByVideoLabel={t('detail.durationLockedByVideo', { duration: inputVideoDuration ?? duration })}
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

        {/* 数字人形象：原本是独立板块，2026-09-30 融入创作页——做视频要给"这张脸"就在这儿给。 */}
        {(isVideoMode || isDraftMode) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            data-testid="toolbar-digital-human"
            onClick={() => setHumanDialogOpen(true)}
          >
            <UserRound className="mr-1 h-3.5 w-3.5" />
            形象
          </Button>
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
            // 平台合规提示：中央网信办 2026-05-13 起把**内容标注**设为短视频发布的必经环节，
            // 发布者必须从 6 类必选标签里选一项（含 AI 生成内容 / 含营销信息 / 含虚构演绎…）。
            // 我们出的是 AI 生成内容，发布时须选「含有 AI 生成内容」；带货再叠加「含有营销信息」。
            // 详见知识库条目《20-平台内容标注与合规》。
            title="发布前请按平台要求选择内容标注：AI 生成内容须选「含有 AI 生成内容」，带货再加「含有营销信息」"
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

        {/* 形象管理弹窗：功能并入本页后随工具栏一起挂载，不占独立路由、不新增板块。 */}
        <DigitalHumanDialog open={humanDialogOpen} onClose={() => setHumanDialogOpen(false)} />
      </div>
    )
  },
)

ToolBarInline.displayName = 'ToolBarInline'

export default ToolBarInline
