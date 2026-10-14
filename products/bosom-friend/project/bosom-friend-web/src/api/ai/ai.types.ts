import type { CreditsScope } from '../_shared/credits.types'
import type { AgentTaskStatus, MediaType } from './ai.constants'
import type { PlatType } from '@web/app/config/platConfig'

// Source: types/ai.ts

/**
 * ChatModel 类型。
 */
export interface ChatModel {
  name: string
  description?: string
  logo?: string
  channel?: string
  scenes?: string[]
  inputModalities?: string[]
  outputModalities?: string[]
  pricing?: ChatModelPricing
  fixedImagePricing?: ChatModelFixedImagePricing[]
  tags?: string[]
  mainTag?: boolean
}

/**
 * ChatModelPricingTier 类型。
 */
export interface ChatModelPricingTier {
  maxInputTokens?: number
  input?: Record<string, string>
  output?: Record<string, string>
}

/**
 * ChatModelPricing 类型。
 */
export interface ChatModelPricing {
  prompt?: string
  completion?: string
  tiers?: ChatModelPricingTier[]
  originPricing?: {
    tiers?: ChatModelPricingTier[]
  }
}

/**
 * ChatModelFixedImagePricing 类型。
 */
export interface ChatModelFixedImagePricing {
  resolution: string
  price: number
}

/**
 * AdaptPlatform 类型。
 */
export type AdaptPlatform
  = | 'douyin' | 'xhs' | 'wxSph' | 'KWAI' | 'youtube' | 'wxGzh' | 'bilibili' | 'twitter' | 'tiktok' | 'facebook' | 'instagram' | 'threads' | 'pinterest' | 'linkedin'

// Source: types/draftGeneration.ts

/**
 * CreateDraftFromVideoUrlDto 请求参数。
 */
export interface CreateDraftFromVideoUrlDto {
  videoUrl: string
  groupId?: string
  platforms?: string[]
}

/**
 * CreateDraftFromVideoUrlVo 响应数据。
 */
export interface CreateDraftFromVideoUrlVo {
  materialId: string
}

/**
 * ImageModelPricing 类型。
 */
export interface ImageModelPricing {
  resolution: string
  /** 该尺寸仅适用于指定比例（0.2.21 起：尺寸与比例一一对应，不再冲突）。 */
  aspectRatio?: string
  /** 该档位在此比例下的成品像素（如 1080p + 3:4 → 1080x1440），由服务端档位表下发。 */
  size?: string
  pricePerImage: number
  originPrice?: number
}

/**
 * ImageModelInfo 数据结构。
 */
export interface ImageModelInfo {
  model: string
  displayName: string
  pricing: ImageModelPricing[]
  supportedAspectRatios?: string[]
  maxInputImages?: number
  tags?: string[]
  /** 图片风格选项（由 pricing 接口声明） */
  styles?: string[]
}

/**
 * VideoModelPricing 类型。
 */
export interface VideoModelPricing {
  duration: number
  price: number
  mode?: string
  resolution?: string
  aspectRatio?: string
  discount?: string
  originPrice?: number
}

/**
 * VideoModelInputConstraint 类型。
 */
export interface VideoModelInputConstraint {
  maxCount?: number
  formats?: string[]
  minDuration?: number
  maxDuration?: number
  maxTotalDuration?: number
  maxSizeMb?: number
  minAspectRatio?: number
  maxAspectRatio?: number
  minWidth?: number
  maxWidth?: number
  minPixels?: number
  maxPixels?: number
  minFps?: number
  maxFps?: number
}

/**
 * VideoModelInputConstraints 类型。
 */
export interface VideoModelInputConstraints {
  images?: VideoModelInputConstraint
  videos?: VideoModelInputConstraint
  audios?: VideoModelInputConstraint
}

/**
 * VideoModelInfo 数据结构。
 */
export interface VideoModelInfo {
  name: string
  description: string
  channel: string
  creditsScope?: CreditsScope
  modes: string[]
  resolutions: string[]
  durations: number[]
  /**
   * 多片段拼装档位（30 / 60 秒）。
   *
   * 官方单次下单只收 4~12 秒，这两档由多个 4 秒片段拼成，所以与 durations 分开声明：
   * 滑块仍只摆 durations（4~12），拼装档位由单独的档位按钮选中。
   */
  longDurations?: number[]
  /** 拼装档位的诚实耗时预估（键为秒数字符串），界面据此提示"约 N~M 分钟 / K 片合成"。 */
  longDurationEstimates?: Record<string, { minMinutes: number, maxMinutes: number, clips: number }>
  maxInputImages: number
  inputConstraints?: VideoModelInputConstraints
  aspectRatios: string[]
  tags: string[]
  /** 视频风格选项（由 pricing 接口声明） */
  styles?: string[]
  defaults: {
    resolution?: string
    aspectRatio?: string
    duration?: number
  }
  pricing: VideoModelPricing[]
}

/**
 * DraftGenerationPricingVo 响应数据。
 */
export interface DraftGenerationPricingVo {
  imageModels: ImageModelInfo[]
  videoModels?: VideoModelInfo[]
}

// Source: ai/ai.api.ts inline types
// Source: agent.ts

/**
 * Media 类型。
 */
export interface Media {
  type: MediaType
  url: string
  coverUrl?: string // 视频封面URL（可选）
}

/**
 * 动作回填台账的一条记录：服务端发放的工单号 → 执行后的真实结果。
 *
 * 动作卡本身只说明"这件事被申请了"；这一步到底做完没有，唯一的事实是这张台账
 * （`POST agent/tasks/:taskId/action-result` 与发布链路写进 `task.actionResults`）。
 * 台账里查不到某个 requestId = 这张卡停在「已申请」，界面显示「未回填」，
 * 不拿"申请过"当"做完了"。
 */
export interface TaskActionResult {
  /** 服务端发放的动作工单号，对应动作卡上的 `requestId`。 */
  requestId: string
  /** 这条工单现在的真实结果；动作卡上的"申请"不因它而改变。 */
  state: 'executed' | 'verified' | 'failed'
  /** 执行后拿到的真实 id（草稿 id / 发布记录 id）；拿不到时为空串。 */
  realId: string
  /** 一句话说明，便于在任务里回看这一步做了什么。 */
  note: string
  /** 回填时间（ISO 字符串）。 */
  at: string
}

/**
 * TaskDetail 数据结构。
 */
export interface TaskDetail {
  id: string
  userId: string
  prompt: string
  title: string
  description: string
  tags: string[]
  status: AgentTaskStatus
  medias: Media[]
  errorMessage: string
  createdAt: string
  updatedAt: string
  messages?: TaskMessage[]
  rating?: number | null
  ratingComment?: string | null

  favoritedAt?: string | null
  /**
   * 归属管家：这条任务由哪个管家在办（`steward` / `creator` / `publisher` / `operator` / `device`）。
   *
   * `null` = 未登记（早于该字段落地的旧任务）：界面显示"未登记"，不拿总管顶替。
   */
  agentRole?: string | null

  /**
   * 动作回填台账（DEF-248）：`requestId` → 这一步的真实结果。
   *
   * 缺省或为空 = 没有回填记录，界面按「未回填」显示（旧任务本来就查不到回填）。
   */
  actionResults?: TaskActionResult[]

  /**
   * 工具轨迹（过程数据）：第几轮、调了哪个工具、成败。服务端随任务一起落盘。
   * 缺字段 = 早于 2026-10-12 的旧任务；**空数组 = 这条任务确实没调过工具**——两者不是一回事。
   */
  toolTrace?: TaskToolTraceEntry[]
}

/** 一条工具调用轨迹（轮次从 1 起；写入与 isError 回填见服务端 types.ts）。 */
export interface TaskToolTraceEntry {
  turn: number
  name: string
  at: string
  isError: boolean
}

/**
 * TaskMessage 类型。
 */
export interface TaskMessage {
  type: 'user' | 'assistant' | 'result' | 'system' | 'stream_event' | 'error'
  uuid?: string
  message?: any
  content?: string | any[]
  parent_tool_use_id?: string | null
  subtype?: string
  code?: number
}

/**
 * 一条任务的模型用量（服务端按知识库蒸馏账本归集，见 server 的 `taskUsageIndex`）。
 *
 * 界面据此回答"这个任务花了多少"。数字全部来自实测，产品没有的部分如实为 `null`。
 */
export interface TaskUsage {
  /** 账本里这条任务的模型调用次数（每条样本 = 一次真实调用）。 */
  modelCalls: number
  /** 这些调用已计到的耗时合计（毫秒）。 */
  modelMs: number
  /** 这些调用里计到的工具调用次数合计。 */
  toolCalls: number
  /** 账本里记为非成功状态的调用次数。 */
  failedCalls: number
  /** 出现过的模型名，按调用次数降序。 */
  models: string[]
  /** 产品不记录 token 数：服务端恒给 null，界面显示"未记录"，不显示 0、也不估算。 */
  tokens: null
}

/**
 * TaskListItem 数据结构。
 */
export interface TaskListItem
{
  id: string
  userId: string

  title?: string

  createdAt: string

  updatedAt: string

  status?: string

  rating?: number | null

  ratingComment?: string | null

  favoritedAt?: string | null

  /**
   * 归属管家：这条任务由哪个管家在办；`null` = 未登记（旧任务），界面不猜。
   */
  agentRole?: string | null

  /**
   * 失败原因原文（只有失败任务有值，成功任务是空串）。
   *
   * 为什么列表项必须带它：任务卡此前只有一个红色的"失败"，用户得逐条点进对话才知道
   * 卡在哪一步（G4 判据「卡在哪」）。
   */
  errorMessage?: string

  /**
   * 这条任务的模型用量；`null` / 缺省 = 未采集（账本里没有它的样本）。
   *
   * **不给 0 顶替**：没记账不等于没花过。
   */
  usage?: TaskUsage | null
}

/**
 * TaskListResponse 响应数据。
 */
export interface TaskListResponse {

  page: number
  pageSize: number
  totalPages: number
  total: number
  list: TaskListItem[]
}

/**
 * CleanupRunningTasksResponse 响应数据。
 * 后端清理 running 任务后返回的清理数量。
 */
export interface CleanupRunningTasksResponse {
  updatedCount: number
}

/**
 * GetTaskListParams 请求参数。
 */
export interface GetTaskListParams {
  page?: number
  pageSize?: number

  keyword?: string

  favoriteOnly?: boolean
}

/**
 * CreateAgentTaskParams 请求参数。
 */
export interface CreateAgentTaskParams {
  prompt: string | any[] // 支持字符串或 Claude Prompt 格式数组
  taskId?: string // 可选，传入则继续上一次对话
  messageUuid?: string // 可选，重置到对应的消息继续
  includePartialMessages?: boolean // 使用流式消息
  /** 用户正在看的对象；由发送链路用 `readAgentFocus()` 填，页面不必自己传。 */
  focus?: {
    page: string
    objectKind: string
    objectId: string
    title: string
    excerpt: string
  }
}

/**
 * CreateTaskResponse 响应数据。
 */
export interface CreateTaskResponse {
  id: string
}

/**
 * ResultType 类型。
 */
export type ResultType = 'imageOnly' | 'videoOnly' | 'fullContent'

/**
 * ResultAction 类型。
 */
export type ResultAction
  = | 'draft' | 'publish' | 'createChannel' | 'updateChannel'
    | 'loginChannel' | 'platformNotSupported'

/**
 * Platform 类型。
 */
export type Platform
  = | 'douyin' | 'xhs' | 'wxSph' | 'KWAI' | 'youtube' | 'wxGzh' | 'bilibili' | 'twitter' | 'tiktok' | 'facebook' | 'instagram' | 'threads' | 'pinterest' | 'linkedin'

/**
 * ResultData 数据结构。
 */
export interface ResultData {
  taskId: string
  title: string
  description: string
  tags: string[]
  medias: Media[]
  type?: ResultType // 结果类型
  action?: ResultAction // 操作类型
  platform?: Platform // 平台类型
  accountType?: string[] // 账户类型数组，如 ['douyin', 'xhs']
}

/**
 * ResultMessage 类型。
 */
export interface ResultMessage {
  type: 'result'
  subtype?: string // 保留兼容性
  uuid: string
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  message: string
  result: ResultData
  total_cost_usd: number
  usage: any
  permission_denials: any[]
}

/**
 * StreamEvent 类型。
 */
export interface StreamEvent {
  type: 'stream_event'
  uuid: string
  event: {
    type:
      | 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop'
    index?: number
    content_block?: any
    delta?: {
      type: 'text_delta' | 'input_json_delta'
      text?: string
      partial_json?: string
    }
    message?: any
    usage?: any
  }
  parent_tool_use_id?: string | null
}

/**
 * SSEMessage 类型。
 */
export interface SSEMessage {
  type:
    | 'init' | 'keep_alive' | 'stream_event' | 'message' | 'status' | 'error' | 'done' | 'text' | 'result'
  taskId?: string
  message?: string | ResultMessage | StreamEvent
  sessionId?: string
  status?: AgentTaskStatus
  data?: any
}

/**
 * TaskMessagesVo 响应数据。
 */
export interface TaskMessagesVo {
  messages: TaskMessage[]
  status?: AgentTaskStatus // 任务状态，可选
}

// Source: draftGeneration.ts
// ==================== 类型定义 ====================

/**
 * 草稿生成任务状态。
 */
export type DraftTaskStatus = 'generating' | 'success' | 'partial' | 'failed'

/**
 * DraftGenerationResponse 响应数据。
 */
export interface DraftGenerationResponse {
  materialId?: string
  mediaId?: string
  mediaIds?: string[]
  title?: string
  description?: string
  topics?: string[]
  videoUrl?: string
  coverUrl?: string
  imageUrls?: string[]
  generatedImageCount?: number
  imageGenerationErrors?: Array<Record<string, unknown>>
  plan?: Record<string, unknown>
}

/**
 * DraftGenerationRequest 请求参数。
 */
export interface DraftGenerationRequest {
  groupId?: string
  model?: string
  imageModel?: string
  plannerModel?: string
  duration?: number
  resolution?: string
  aspectRatio?: string
  prompt?: string
  captionPrompt?: string
  /** 画面风格；图片/视频接口无独立风格参数，生成时作为提示词约束下发。 */
  style?: string
  imageUrls?: string[]
  videoUrls?: string[]
  audioUrls?: string[]
  imageCount?: number
  imageSize?: string
  platforms?: PlatType[]
  draftType?: VideoDraftType | ImageTextDraftType
  /**
   * 生成类型元数据：**由服务端写入生成记录**（`server/src/api.ts` 的 `createDraftGeneration`），
   * 取值与下游路由一致（`'video'` / `'image-text'`）；前端据此在「重新生成」时选择对应接口。
   *
   * **不要把它回传给下游 API**：`CreateVideoDraftGenerationParams` 与
   * `CreateImageTextDraftGenerationParams` 都不接受该字段，构造载荷时须先删除
   * （见 `GeneratingCard` 的 `delete payload.kind`）。
   */
  kind?: 'video' | 'image-text'
}

/**
 * DraftGenerationTask 类型。
 */
export interface DraftGenerationTask {
  id: string
  status: DraftTaskStatus
  points: number
  errorMessage?: string
  request?: DraftGenerationRequest
  response?: DraftGenerationResponse | string
  /**
   * 分段生成时长片时的实时进度（>12 秒的档位才有，由后端按内部分段任务算好）。
   * 界面据此显示"逐镜生成 9/17"，而不是只给一个"生成中"。
   */
  progress?: {
    /** 当前阶段：写稿与排分镜 / 逐镜生成 / 合成与导出。 */
    stage: string
    /** 整条片子的完成度（0~99；成片落盘后状态即变为成功，不再走这里）。 */
    percent: number
    shotsReady: number
    shotsTotal: number
    targetSeconds: number
    taskId: string
  }
  createdAt: string
  updatedAt: string
}

/**
 * DraftGenerationStats 数据结构。
 */
export interface DraftGenerationStats {
  generatingCount: number
}

/**
 * CreateDraftGenerationVo 响应数据。
 */
export interface CreateDraftGenerationVo {
  taskIds: string[]
}

/**
 * DraftGenerationTaskListVo 响应数据。
 */
export interface DraftGenerationTaskListVo {
  page: number
  pageSize: number
  totalPages: number
  total: number
  list: DraftGenerationTask[]
}

// ==================== API 调用 ====================

/**
 * 视频生成模型类型标识。
 */
export type VideoModelType = string

/**
 * ImageModelType 类型。
 */
export type ImageModelType = string

/**
 * DraftContentType 类型。
 */
export type DraftContentType = 'video' | 'image_text'

/**
 * VideoDraftType 类型。
 */
export type VideoDraftType = 'draft' | 'video'

/**
 * ImageTextDraftType 类型。
 */
export type ImageTextDraftType = 'draft' | 'image'

/**
 * Agent 任务评分数据。
 */
export interface AgentTaskRatingData {
  rating?: number | null
  comment?: string | null
}

/**
 * Agent 任务评分响应：服务端在 data 里直接回 rating/comment，不再多包一层（DEF-018）。
 */
export type AgentTaskRatingResponse = AgentTaskRatingData

/**
 * 提交 Agent 任务评分请求参数。
 */
export interface SubmitAgentTaskRatingPayload {
  rating: number
  comment?: string
}

/**
 * Agent 任务公开分享响应。
 */
export interface AgentTaskShareVo {
  token: string
  expiresAt: string
  urlPath: string
}

/**
 * AI 分页查询参数。
 */
export interface AiPaginationParams {
  page?: number
  pageSize?: number
}

/**
 * 视频生成历史时间戳。
 */
export type VideoGenerationTimestamp = number | string | null | undefined

/**
 * 视频生成历史记录项。
 */
export interface VideoGenerationHistoryItem {
  task_id: string
  action: string
  status: 'SUCCESS' | 'FAILED' | 'PROCESSING' | string
  fail_reason?: string
  submit_time?: VideoGenerationTimestamp
  start_time?: VideoGenerationTimestamp
  finish_time?: VideoGenerationTimestamp
  progress: string
  prompt: string
  data?: {
    completed_at?: VideoGenerationTimestamp
    created_at?: VideoGenerationTimestamp
    error?: string | null
    id?: string
    model?: string
    object?: string
    progress?: number
    result_url?: string
    seconds?: string
    size?: string
    status?: string
    url?: string
    video_url?: string
  }
}

/**
 * 视频生成历史列表响应数据。
 */
export interface VideoGenerationHistoryListVo {
  list?: VideoGenerationHistoryItem[]
  total?: number
  page?: number
  pageSize?: number
  totalPages?: number
}

/**
 * AI 日志查询参数。
 */
export interface AiLogListParams extends AiPaginationParams {
  startDate?: string
  endDate?: string
}

/**
 * AI 聊天消息。
 */
export interface AiChatMessage {
  role: string
  content: string
}

/**
 * AI 聊天请求参数。
 */
export interface AiChatStreamParams {
  messages: AiChatMessage[]
  stream?: boolean
  model?: string
  temperature?: number
  presence_penalty?: number
  frequency_penalty?: number
  top_p?: number
  max_tokens?: number
}

/**
 * AI 视频草稿批量生成请求参数。
 */
export interface CreateVideoDraftGenerationParams {
  quantity: number
  groupId: string
  model: VideoModelType
  prompt?: string
  captionPrompt?: string
  style?: string
  imageUrls?: string[]
  videoUrls?: string[]
  audioUrls?: string[]
  duration?: number
  resolution?: string
  aspectRatio?: string
  platforms?: PlatType[]
  draftType?: VideoDraftType
}

/**
 * AI 图文草稿批量生成请求参数。
 */
export interface CreateImageTextDraftGenerationParams {
  quantity: number
  groupId: string
  prompt: string
  captionPrompt?: string
  style?: string
  imageModel: ImageModelType
  imageCount?: number
  imageUrls?: string[]
  aspectRatio?: string
  imageSize?: string
  platforms?: PlatType[]
  draftType?: ImageTextDraftType
}
