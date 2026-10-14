import type { DraftContentType, VideoModelType } from '@web/api/ai/ai.types'
import type { PlatType } from '@web/app/config/platConfig'
import type {
  DraftBoxConfig,
  ModelSelectionMode,
  VideoModelParams,
} from '@web/store/draft-box/draftBoxConfigStore'

export interface AiBatchGenerateBarLocalState {
  promptValue: string
  promptEditorOpen: boolean
  aspectRatio: string
  duration: number
  resolution: string
  modelType: VideoModelType
  selectedVideoModels: VideoModelType[]
  videoModelSelectionMode: ModelSelectionMode
  videoModelResolutions: Record<string, string>
  videoModelParams: Record<string, VideoModelParams>
  contentType: DraftContentType
  imageModel: string
  selectedImageModels: string[]
  imageModelSelectionMode: ModelSelectionMode
  imageCount: number
  imageSize: string
  quantity: number
  isDraftMode: boolean
  style: string
  captionSystemPrompt: string
  captionSystemPromptDefault: string
  moreOptionsOpen: boolean
  selectedPlatforms: PlatType[]
}

export interface BuildAiBatchGenerateBarStateParams {
  config: DraftBoxConfig
  forceDraftMode: boolean
  availablePlatforms: PlatType[]
}

export type AiBatchGenerateBarStateValue<Key extends keyof AiBatchGenerateBarLocalState>
  = | AiBatchGenerateBarLocalState[Key]
    | ((current: AiBatchGenerateBarLocalState[Key]) => AiBatchGenerateBarLocalState[Key])

export type AiBatchGenerateBarStatePatch = Partial<AiBatchGenerateBarLocalState>
