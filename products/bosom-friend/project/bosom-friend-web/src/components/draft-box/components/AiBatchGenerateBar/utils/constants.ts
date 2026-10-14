/**
 * AI 批量生成 - 模型配置常量
 * 积分与时长等动态数据已由 pricing API 驱动，此处仅保留 API 不提供的静态配置
 */

import type { CreditsScope } from '@web/api/_shared/credits.types'
import type { DraftContentType, ImageModelInfo, VideoModelInfo, VideoModelInputConstraint, VideoModelPricing } from '@web/api/ai/ai.types'

/** 根据比例字符串（如 "9:16"）计算预览方块的 w/h（缩放到合适的 UI 尺寸） */
export function ratioToPreviewSize(label: string): { w: number, h: number } {
  const [a, b] = label.split(':').map(Number)
  if (!a || !b)
    return { w: 14, h: 14 }
  const maxDim = 18
  const scale = maxDim / Math.max(a, b)
  return { w: Math.round(a * scale), h: Math.round(b * scale) }
}

/** 「产品与卖点」输入框的字符上限；与 server/src/long-video.ts 的 MAX_LONG_VIDEO_TOPIC_CHARS 同一个数。 */
export const MAX_LONG_VIDEO_TOPIC_CHARS = 800

/**
 * 接近上限时的字数提醒（DEF-114）。
 *
 * 上限存在的意义是不让请求无限大，但用户看不到它时就会以为"没写错"——写满被截掉的卖点
 * 直接变成写稿原料的损失。这里只在上限附近出声，不打断输入。
 *
 * @param length - 当前已输入的字数。
 * @returns 提示文案；离上限还远时为空串。
 */
export function topicLengthHint(length: number): string {
  if (!Number.isFinite(length) || length < MAX_LONG_VIDEO_TOPIC_CHARS * 0.9) return ''
  if (length >= MAX_LONG_VIDEO_TOPIC_CHARS) return '已到 ' + String(MAX_LONG_VIDEO_TOPIC_CHARS) + ' 字上限，再写不会被收进卖点；把长内容留给「专业提示词增强」写成的稿子'
  return '已写 ' + String(Math.floor(length)) + ' / ' + String(MAX_LONG_VIDEO_TOPIC_CHARS) + ' 字'
}

/**
 * 卖点字数与这条片的稿子下限差多少（DEF-108 的前置提示用）。
 *
 * 输入框本身就是文案，填进去的每一个字都会变成稿子的原料；字数不够时后端会自动扩写，
 * 所以这里只负责把"我给了多少 / 这条片至少要多少"摆到用户眼前，不做拦截。
 *
 * 计数口径与后端不同，必须说清：这里数的是**用户敲进去的字**（含标点），
 * 而后端的门槛与语速是**去标点**口径（DEF-113）——所以文案里一律写明"不含标点"，
 * 否则用户按自己看到的字数以为够了，后端却按去标点的字数判它不够。
 *
 * @param briefChars - 用户当前填写的卖点字数（含标点，输入框原位计数）。
 * @param requirement - 后端下发的这一档口播稿字数下限（不含标点）与折算口径。
 * @returns 提示文案与是否已达下限。
 */
export function briefCharsHint(
  briefChars: number,
  requirement: { requiredChars: number, charsPerSecond: number, targetSeconds: number } | null,
): { text: string, meets: boolean } {
  if (requirement === null) return { text: '', meets: false }
  const filled = Number.isFinite(briefChars) && briefChars > 0 ? Math.floor(briefChars) : 0
  if (filled === 0) {
    return {
      text: '还没填卖点：这条片要 ' + String(requirement.requiredChars) + ' 字成稿（不含标点，'
        + String(requirement.charsPerSecond) + ' 字/秒 × ' + String(requirement.targetSeconds) + ' 秒），空着不会开始',
      meets: false,
    }
  }
  if (filled >= requirement.requiredChars) {
    return { text: '卖点 ' + String(filled) + ' 字，已够这条片要的 ' + String(requirement.requiredChars) + ' 字成稿（不含标点）', meets: true }
  }
  return {
    text: '卖点 ' + String(filled) + ' 字 → 这条片要 ' + String(requirement.requiredChars) + ' 字成稿（不含标点）；差的字由后端自动补写，补不够就停在这一步、不花厂商额度',
    meets: false,
  }
}

/**
 * 内容创作的单条时长上限（秒）：5 分钟。
 *
 * 长片不再是另一个板块：内容创作一个入口，**时长决定走单次还是分段**——
 * ≤12 秒走官方单次，更长走分段拼接（每片 4 秒，官方单次上限 12 秒）。
 * 每档的诚实耗时由后端的 estimateMinutes 算给界面，用户按预估自己权衡。
 */
export const MAX_ENABLED_VIDEO_DURATION_SECONDS = 300

/**
 * 短视频板块允许出现的最长档位（秒）：模型声明的更长档位一律按"不适用于本板块"过滤掉。
 *
 * 与 {@link MAX_ENABLED_VIDEO_DURATION_SECONDS} 分开命名是有意的：
 * 前者是"要不要禁"，这里是"这一档算不算短视频"，两个判断的依据不同（实测踩过一次混用）。
 */
export const SHORT_VIDEO_MAX_SECONDS = 60

/**
 * 内容创作默认时长（秒）：新增一条内容时没有特殊要求就用它。
 *
 * 不再是"超上限就回退 15"那种隐式兜底：兜底值集中在这里，改动只需动一处。
 */
export const DEFAULT_VIDEO_DURATION_SECONDS = 15

/**
 * 把模型声明的时长档位收成**本板块可用**的那一组：超长短视频上限的档位直接不出现。
 *
 * @param durations - 模型声明的可选时长（秒）。
 * @returns 升序排列的可用档位；输入为空时给出默认档位。
 */
export function enabledVideoDurationOptions(durations: number[] | undefined): number[] {
  const candidates = (durations ?? [])
    .filter(seconds => Number.isFinite(seconds) && seconds > 0 && seconds <= SHORT_VIDEO_MAX_SECONDS)
  const unique = [...new Set(candidates)].sort((a, b) => a - b)
  return unique.length > 0 ? unique : [DEFAULT_VIDEO_DURATION_SECONDS]
}

/** 将任意视频时长收敛到当前可选的档位：不在可用档位内就回退默认值。 */
/** 多片段拼装档位（秒）：官方单次只收 4~12，这些档位由多个 4 秒片段拼成（30 秒 ~ 5 分钟）。 */
export const COMPOSED_VIDEO_DURATION_GEARS: readonly number[] = [30, 60, 90, 120, 180, 300]

/**
 * 当前选中的视频模型共同支持的**全部**可选档位（原生档位 + 多片段拼装档位）。
 *
 * 为什么必须一起给：界面上视频时长有两个入口——独立的「视频时长」选择器只列 durations
 * （官方 4~12 秒），30 秒 / 1 分钟只在模型参数面板里当按钮。用户在两处看到的是同一件事，
 * 少了任何一处，选了 30 秒就会在另一个入口被收敛回 12 秒（实测形态：选了没生效、
 * 而且 4~12 那些档位也跟着表现异常）。
 *
 * @param models - 当前选中的视频模型。
 * @returns 升序档位；模型未声明原生档位时返回空数组（界面回落到滑块）。
 */
export function getEnabledVideoDurations(models: VideoModelInfo[]): number[] {
  if (models.length === 0)
    return []
  const common = getCommonNumbers(models.map(model => model.durations ?? []))
  // 拼装档位同样按「所有选中模型都支持」取交集：多选时不能拿一个模型的长档位去下单另一个模型。
  const composed = getCommonNumbers(models.map(model => model.longDurations ?? []))
  return [...new Set([...common, ...composed.filter(seconds => !common.includes(seconds))])]
    .sort((a, b) => a - b)
}

/**
 * 取多组数字的交集；任一组为空则交集为空。
 *
 * @param groups - 待求交集的数字组。
 * @returns 交集（升序去重）。
 */
function getCommonNumbers(groups: number[][]): number[] {
  if (groups.length === 0)
    return []
  const [first = [], ...rest] = groups
  if (first.length === 0 || rest.some(group => group.length === 0))
    return []
  return [...new Set(first)].filter(value => rest.every(group => group.includes(value))).sort((a, b) => a - b)
}

/**
 * 是不是多片段拼装档位。
 *
 * 这类档位**不在滑块的 4~12 区间里**，任何"夹进区间"的收敛都会把用户选的 30 秒静默改成 12 秒
 * （就是"参数没起作用"那种形态），所以凡遇到它们一律原样放行。
 *
 * @param value - 时长（秒）。
 * @returns true 表示这是拼装档位。
 */
export function isComposedVideoDuration(value: number): boolean {
  return COMPOSED_VIDEO_DURATION_GEARS.includes(value)
}

/**
 * 把任意视频时长收敛到当前可选的档位。
 *
 * @param duration - 目标时长（秒）。
 * @param durations - 模型声明的原生档位；拼装档位（30/60）不受它约束。
 * @returns 可用档位；不在其中时回落到默认档。
 */
export function sanitizeVideoDuration(duration: number, durations?: number[]): number {
  // 拼装档位（30/60）按定义不在模型的 durations 里，收敛时必须先放行，否则选中后一刷新
  // 就被改回默认档（实测形态：选了 30 秒，界面与下单都变回 12 秒）。
  if (isComposedVideoDuration(duration))
    return duration
  const options = enabledVideoDurationOptions(durations)
  if (options.includes(duration))
    return duration
  return options.find(option => option === DEFAULT_VIDEO_DURATION_SECONDS)
    ?? options.find(option => option === 5)
    ?? options[0]
    ?? DEFAULT_VIDEO_DURATION_SECONDS
}

/** 时长药丸的三种状态。 */
export type DurationPillState = 'locked-by-video' | 'fixed' | 'chooser'

/**
 * 时长药丸该长成什么样。
 *
 * 判定收在这里、由单测钉住，因为「用户看到的时长」与「真正会提交的时长」必须是同一个：
 * 编辑态下素材时长决定成片时长，提交链路取 `inputVideoDuration ?? duration`——
 * 于是只有 `inputVideoDuration` 读得出时药丸才该锁死并显示它；读不出（还没解析完）时用户选的档位
 * **确实会生效**，此时把人挡住反而是错的（DEF-112 的形态一就是药丸显示 30 秒、下单 5 秒）。
 *
 * @param params - 编辑态标记、素材合计时长（读不出为 null）、当前模型档位的上下限。
 * @returns locked-by-video：显示素材合计时长且不可点；fixed：只有唯一档位；chooser：可点开改档位。
 */
export function durationPillState(params: {
  isVideoEditMode: boolean
  inputVideoDuration: number | null
  limitMin: number
  limitMax: number
}): DurationPillState {
  if (params.isVideoEditMode && params.inputVideoDuration !== null)
    return 'locked-by-video'
  if (params.limitMin === params.limitMax)
    return 'fixed'
  return 'chooser'
}
export function getVideoModelCreditsScope(model?: VideoModelInfo): CreditsScope {
  if (model?.creditsScope === 'seedance')
    return 'seedance'
  return 'general'
}

export function isSeedanceCreditsModel(model?: VideoModelInfo): boolean {
  return getVideoModelCreditsScope(model) === 'seedance'
}

// ==================== 视频模型配置 ====================

/** 视频模型静态配置 */
export interface VideoModelStaticConfig {
  supportedRatios: Set<string>
  maxImages: number
  maxVideos: number
  maxAudios: number
  maxVideoDuration: number
  maxAudioDuration: number
  imageInputConstraints?: VideoModelInputConstraint
  videoInputConstraints?: VideoModelInputConstraint
  audioInputConstraints?: VideoModelInputConstraint
}

/** 允许上传图片的 modes */
const IMAGE_UPLOAD_MODES = new Set(['image2video', 'multi-image2video', 'flf2video', 'lf2video', 'multi-ref'])
const VIDEO_UPLOAD_MODE = 'video2video'
const MIXED_REFERENCE_MODE = 'multi-ref'
const DEFAULT_VIDEO_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const DEFAULT_VIDEO_DURATION_LIMITS = { min: 3, max: 15 }

function normalizeOptionValue(value: string) {
  return value.trim()
}

function getOptionCompareKey(value: string) {
  return normalizeOptionValue(value).replace(/\s+/g, '').toLowerCase()
}

function getUniqueStrings(values: string[]) {
  const normalizedValues = new Map<string, string>()
  values.forEach((value) => {
    const normalizedValue = normalizeOptionValue(value)
    if (!normalizedValue)
      return
    const normalizedKey = getOptionCompareKey(normalizedValue)
    if (!normalizedValues.has(normalizedKey))
      normalizedValues.set(normalizedKey, normalizedValue)
  })
  return [...normalizedValues.values()]
}

function getCommonStrings(groups: string[][]) {
  const nonEmptyGroups = groups
    .map(group => getUniqueStrings(group))
    .filter(group => group.length > 0)
  if (nonEmptyGroups.length === 0)
    return []

  const [firstGroup, ...restGroups] = nonEmptyGroups
  if (!firstGroup)
    return []

  return firstGroup.filter(item => restGroups.every(group =>
    group.some(value => getOptionCompareKey(value) === getOptionCompareKey(item))))
}

export function getVideoModelAspectRatios(model?: VideoModelInfo): string[] {
  const ratios = getUniqueStrings(model?.aspectRatios?.filter(Boolean) ?? [])
  return ratios.length > 0 ? ratios : DEFAULT_VIDEO_ASPECT_RATIOS
}

/** 从 API 返回的 VideoModelInfo 动态生成静态配置 */
export function getVideoModelConfigFromApi(model: VideoModelInfo): VideoModelStaticConfig {
  const canUploadMixedReference = model.modes.includes(MIXED_REFERENCE_MODE)
  const canUploadVideo = model.modes.includes(VIDEO_UPLOAD_MODE) || canUploadMixedReference
  const videoInputConstraints = model.inputConstraints?.videos
  const audioInputConstraints = model.inputConstraints?.audios
  const imageInputConstraints = model.inputConstraints?.images
  const maxModelDuration = model.durations.length > 0 ? Math.max(...model.durations) : 10
  return {
    supportedRatios: new Set(getVideoModelAspectRatios(model)),
    maxImages: model.modes.some(m => IMAGE_UPLOAD_MODES.has(m)) ? imageInputConstraints?.maxCount ?? model.maxInputImages : 0,
    maxVideos: canUploadVideo ? videoInputConstraints?.maxCount ?? 1 : 0,
    maxAudios: canUploadMixedReference ? audioInputConstraints?.maxCount ?? 1 : 0,
    maxVideoDuration: canUploadVideo
      ? videoInputConstraints?.maxTotalDuration ?? videoInputConstraints?.maxDuration ?? maxModelDuration
      : maxModelDuration,
    maxAudioDuration: canUploadMixedReference
      ? audioInputConstraints?.maxTotalDuration ?? audioInputConstraints?.maxDuration ?? maxModelDuration
      : maxModelDuration,
    imageInputConstraints,
    videoInputConstraints: canUploadVideo ? videoInputConstraints : undefined,
    audioInputConstraints: canUploadMixedReference ? audioInputConstraints : undefined,
  }
}

/** 默认静态配置，API 数据不可用时兜底 */
const DEFAULT_STATIC_CONFIG: VideoModelStaticConfig = {
  supportedRatios: new Set(DEFAULT_VIDEO_ASPECT_RATIOS),
  maxImages: 1,
  maxVideos: 0,
  maxAudios: 0,
  maxVideoDuration: 10,
  maxAudioDuration: 10,
}

/** 获取视频模型的静态配置：优先从 API 数据动态生成，兜底用默认值 */
export function getVideoModelStaticConfig(modelName: string, videoModels?: VideoModelInfo[]): VideoModelStaticConfig {
  if (videoModels) {
    const model = videoModels.find(m => m.name === modelName)
    if (model)
      return getVideoModelConfigFromApi(model)
  }
  return DEFAULT_STATIC_CONFIG
}

/** 分辨率数值化排序权重（480p < 720p < 1080p < 2K < 4K） */
function resolutionRank(value: string): number {
  const v = value.trim().toLowerCase()
  const n = parseInt(v, 10)
  if (Number.isNaN(n))
    return v.includes('2k') ? 2000 : v.includes('4k') ? 4000 : 9999
  return n
}

/** 获取视频模型可选分辨率，优先使用模型字段，缺失时从 pricing 兜底；按分辨率数值升序排列 */
export function getVideoModelResolutions(model?: VideoModelInfo): string[] {
  const resolutions = getUniqueStrings(model?.resolutions?.filter(Boolean) ?? [])
  if (resolutions.length === 0) {
    const fromPricing = getUniqueStrings(model?.pricing?.map(item => item.resolution).filter((item): item is string => !!item) ?? [])
    return fromPricing.sort((a, b) => resolutionRank(a) - resolutionRank(b))
  }
  return resolutions.sort((a, b) => resolutionRank(a) - resolutionRank(b))
}

export function getVideoModelsCommonResolutions(models: VideoModelInfo[]): string[] {
  return getCommonStrings(models.map(model => getVideoModelResolutions(model)))
}

export function getVideoModelsCommonAspectRatios(models: VideoModelInfo[]): string[] {
  return getCommonStrings(models.map(model => getVideoModelAspectRatios(model)))
}

export function getVideoModelsCommonStaticConfig(models: VideoModelInfo[]): VideoModelStaticConfig {
  if (models.length === 0)
    return DEFAULT_STATIC_CONFIG

  const configs = models.map(model => getVideoModelConfigFromApi(model))
  return {
    supportedRatios: new Set(getVideoModelsCommonAspectRatios(models)),
    maxImages: Math.min(...configs.map(config => config.maxImages)),
    maxVideos: Math.min(...configs.map(config => config.maxVideos)),
    maxAudios: Math.min(...configs.map(config => config.maxAudios)),
    maxVideoDuration: Math.min(...configs.map(config => config.maxVideoDuration)),
    maxAudioDuration: Math.min(...configs.map(config => config.maxAudioDuration)),
    imageInputConstraints: mergeInputConstraints(configs.map(config => config.imageInputConstraints)),
    videoInputConstraints: mergeInputConstraints(configs.map(config => config.videoInputConstraints)),
    audioInputConstraints: mergeInputConstraints(configs.map(config => config.audioInputConstraints)),
  }
}

function mergeInputConstraints(constraints: Array<VideoModelInputConstraint | undefined>) {
  const items = constraints.filter((item): item is VideoModelInputConstraint => Boolean(item))
  if (items.length === 0)
    return undefined
  return {
    maxCount: minOptional(items.map(item => item.maxCount)),
    formats: intersectFormats(items.map(item => item.formats)),
    minDuration: maxOptional(items.map(item => item.minDuration)),
    maxDuration: minOptional(items.map(item => item.maxDuration)),
    maxTotalDuration: minOptional(items.map(item => item.maxTotalDuration)),
    maxSizeMb: minOptional(items.map(item => item.maxSizeMb)),
    minAspectRatio: maxOptional(items.map(item => item.minAspectRatio)),
    maxAspectRatio: minOptional(items.map(item => item.maxAspectRatio)),
    minWidth: maxOptional(items.map(item => item.minWidth)),
    maxWidth: minOptional(items.map(item => item.maxWidth)),
    minPixels: maxOptional(items.map(item => item.minPixels)),
    maxPixels: minOptional(items.map(item => item.maxPixels)),
    minFps: maxOptional(items.map(item => item.minFps)),
    maxFps: minOptional(items.map(item => item.maxFps)),
  }
}

function minOptional(values: Array<number | undefined>) {
  const items = values.filter((value): value is number => value !== undefined)
  return items.length > 0 ? Math.min(...items) : undefined
}

function maxOptional(values: Array<number | undefined>) {
  const items = values.filter((value): value is number => value !== undefined)
  return items.length > 0 ? Math.max(...items) : undefined
}

function intersectFormats(formatGroups: Array<string[] | undefined>) {
  const groups = formatGroups
    .filter((formats): formats is string[] => Boolean(formats?.length))
    .map(formats => formats.map(format => format.trim().toLowerCase()).filter(Boolean))
  if (groups.length === 0)
    return undefined
  const [firstGroup, ...restGroups] = groups
  return firstGroup?.filter(format => restGroups.every(group => group.includes(format)))
}

/** 获取视频模型默认分辨率 */
export function getVideoModelDefaultResolution(model?: VideoModelInfo): string {
  return model?.defaults?.resolution ?? getVideoModelResolutions(model)[0] ?? ''
}

export function getVideoModelDurationLimits(
  model: VideoModelInfo | undefined,
  resolution: string,
  isVideoEditMode: boolean,
): { min: number, max: number } {
  if (!model)
    return DEFAULT_VIDEO_DURATION_LIMITS

  const pricing = filterVideoPricingByResolution(model.pricing, resolution, isVideoEditMode)
  const durations = pricing.length > 0 ? pricing.map(item => item.duration) : model.durations
  if (durations.length === 0)
    return DEFAULT_VIDEO_DURATION_LIMITS

  return {
    min: Math.min(...durations),
    max: Math.max(...durations),
  }
}

/** 按模式与分辨率过滤视频定价；模型无分辨率定价时复用通用价格 */
export function filterVideoPricingByResolution(
  pricing: VideoModelPricing[] | undefined,
  resolution: string,
  isVideoEditMode: boolean,
): VideoModelPricing[] {
  const pricingItems = pricing ?? []
  const modePricing = isVideoEditMode
    ? pricingItems.filter(item => item.mode === 'video2video')
    : pricingItems.filter(item => !item.mode)
  const effectiveModePricing = modePricing.length > 0 ? modePricing : pricingItems.filter(item => !item.mode)

  if (resolution) {
    const resolutionPricing = effectiveModePricing.filter(item => item.resolution?.toLowerCase() === resolution.toLowerCase())
    if (resolutionPricing.length > 0)
      return resolutionPricing
  }

  const genericPricing = effectiveModePricing.filter(item => !item.resolution)
  return genericPricing.length > 0 ? genericPricing : effectiveModePricing
}

/** 按目标时长获取最接近的视频定价项 */
export function getNearestVideoPricing(pricing: VideoModelPricing[], duration: number) {
  const exactMatch = pricing.find(item => item.duration === duration)
  if (exactMatch)
    return exactMatch
  return [...pricing].sort(
    (a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration),
  )[0]
}

/** 获取视频模型指定分辨率的每秒积分价格 */
export function getVideoModelPricePerSecond(
  model: VideoModelInfo | undefined,
  resolution: string,
  duration: number,
  isVideoEditMode: boolean,
) {
  if (!model)
    return null

  const pricing = filterVideoPricingByResolution(model.pricing, resolution, isVideoEditMode)
  const nearestPricing = getNearestVideoPricing(pricing, duration)
  if (!nearestPricing || nearestPricing.duration <= 0)
    return null

  return nearestPricing.price / nearestPricing.duration
}

// ==================== 视频比例匹配 ====================

/** 将视频宽高匹配到最近的支持比例 */
export function matchClosestRatio(width: number, height: number, supportedRatios: Set<string>): string | null {
  const videoRatio = width / height
  let closest: string | null = null
  let minDiff = Infinity
  for (const label of supportedRatios) {
    const [w, h] = label.split(':').map(Number)
    const ratio = w! / h!
    const diff = Math.abs(videoRatio - ratio)
    if (diff < minDiff) {
      minDiff = diff
      closest = label
    }
  }
  return closest
}

// ==================== 图文模型常量 ====================

export const DEFAULT_MAX_INPUT_IMAGES = 14

export const IMAGE_TEXT_ASPECT_RATIOS = [
  { label: '1:1', w: 14, h: 14 },
  { label: '3:4', w: 12, h: 16 },
  { label: '4:3', w: 16, h: 12 },
  { label: '9:16', w: 10, h: 18 },
  { label: '16:9', w: 18, h: 10 },
]

/** 获取图片模型支持的比例，优先使用 pricing API 返回值，缺失时使用旧兜底 */
export function getImageModelAspectRatios(model?: ImageModelInfo): string[] {
  const supported = getUniqueStrings(model?.supportedAspectRatios?.filter(Boolean) ?? [])
  if (supported?.length)
    return supported
  return IMAGE_TEXT_ASPECT_RATIOS.map(ratio => ratio.label)
}

export function getImageModelsCommonAspectRatios(models: ImageModelInfo[]): string[] {
  return getCommonStrings(models.map(model => getImageModelAspectRatios(model)))
}

export function getImageModelsCommonResolutions(models: ImageModelInfo[]): string[] {
  return getCommonStrings(models.map(model => model.pricing.map(item => item.resolution).filter(Boolean)))
}

export function getImageModelsMaxInputImages(models: ImageModelInfo[]): number {
  if (models.length === 0)
    return DEFAULT_MAX_INPUT_IMAGES

  return Math.min(...models.map(model => model.maxInputImages ?? DEFAULT_MAX_INPUT_IMAGES))
}

export const IMAGE_COUNT_LIMITS = { min: 1, max: 9 }

// ==================== 画面风格常量 ====================

/**
 * 画面风格选项。图片/视频厂商接口只接受 prompt/model/n/size 等字段，没有独立的风格参数，
 * 风格只能作为提示词约束下发；列表首项即未选择时实际生效的默认风格，与按钮展示保持一致。
 */
export const VIDEO_STYLE_OPTIONS = ['口播实拍', '电影感', '快节奏混剪', '叙事旅行', '产品大片', '生活纪录']

export const IMAGE_STYLE_OPTIONS = ['写实', '插画', '水彩', '油画', '卡通', '赛博朋克', '电影感', '极简']

/** 取当前内容类型实际生效的风格：用户已选则用用户选项，未选择时回落到列表首项（按钮展示的那一项）。 */
export function resolveEffectiveStyle(style: string, contentType: DraftContentType): string {
  if (style !== '')
    return style
  return (contentType === 'video' ? VIDEO_STYLE_OPTIONS[0] : IMAGE_STYLE_OPTIONS[0]) ?? ''
}
