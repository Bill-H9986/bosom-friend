import type { AiBatchGenerateBarLocalState } from '../../../store'
import type { ToolBarInlineActions, ToolBarInlineProps } from './base'

export type UseToolBarDerivedDataParams = Pick<
  AiBatchGenerateBarLocalState,
  | 'contentType'
  | 'duration'
  | 'selectedImageModels'
  | 'selectedVideoModels'
  | 'videoModelParams'
  | 'videoModelSelectionMode'
> & Pick<
  ToolBarInlineProps,
  | 'imageAspectRatios'
  | 'imageModelOptions'
  | 'inputVideoDuration'
  | 'isVideoEditMode'
  | 'videoAspectRatios'
  | 'videoModelOptions'
  | 'videoModels'
  | 'videoResolutions'
> & {
  selectModelsLabel: string
  /** 一个模型都没配时胶囊上显示的短标签（长说明在下拉里，胶囊放不下）。 */
  noModelLabel: string
}

export type UseToolBarActionsParams = Pick<
  AiBatchGenerateBarLocalState,
  | 'imageModelSelectionMode'
  | 'selectedImageModels'
  | 'selectedVideoModels'
  | 'videoModelSelectionMode'
> & Pick<
  ToolBarInlineActions,
  'onImageCountChange' | 'onImageModelsChange' | 'onQuantityChange' | 'onVideoModelsChange'
>

export type UseToolBarDraftValuesParams = Pick<AiBatchGenerateBarLocalState, 'duration'>
  & Pick<ToolBarInlineActions, 'onDurationChange' | 'onVideoModelParamChange'>
