import type {
  PlatformInfo,
  PlatformInfoTuple,
  PlatformMediaRules,
  PlatformMetadataVo,
} from '@web/api/channels/channel.types'
import { PlatformStatus, PublishContentMode } from '@web/api/channels/channel.constants'
import { DOMESTIC_PLATFORMS, PlatType } from '@web/app/config/platConfig'
import { PubType } from '@web/app/config/publishConfig'
import { isChineseLanguage } from '@web/app/i18n/languageConfig'
import { getStaticPlatformIcon } from '@web/store/platformMetadata/staticIcons'
import { resolveAsset } from '@web/utils/assetPath'

/** 渠道能连上、但当前不作为内容创作目标平台的平台（发布链路未接通或未验证）。 */
export const TASK_EXCLUDED_PLATFORMS = new Set<PlatType>([
  PlatType.WxGzh,
])

const COLLECT_UNSUPPORTED_PLATFORMS = new Set<PlatType>([])

const VIEW_UNSUPPORTED_PLATFORMS = new Set<PlatType>([
  PlatType.Xhs,
])

/**
 * 频道平台白名单：「添加频道」与内容创作目标平台共用的一份清单。
 *
 * 小红书 / 抖音 / 快手 / 视频号由引擎带模块、可真连接；闲鱼是新接的适配器，
 * 登录已通、发布未接通，因此能出现在「添加频道」，但不会被列成内容创作的目标平台
 * （目标平台要求 capabilities.publish.supported，能连上 ≠ 能发出去）。
 */
// 白名单的唯一定义在服务端（server/src/platform-catalog.ts 的 PRODUCT_CHANNEL_PLATFORMS），
// 由目录接口的 channel 字段下发。前端曾经也维护一份同样的数组，两份清单必然会漂移——
// 现在这里只读服务端结论。

const platformValues = new Set<string>(Object.values(PlatType))

const DEFAULT_PLATFORM_DISPLAY_NAMES: Record<PlatType, Partial<Record<string, string>>> = {
  [PlatType.Douyin]: {
    'en': 'Douyin',
    'en-US': 'Douyin',
    'zh-CN': '抖音',
  },
  [PlatType.Xhs]: {
    'en': 'RedNote',
    'en-US': 'RedNote',
    'zh-CN': '小红书',
  },
  [PlatType.WxSph]: {
    'en': 'WeChat Channels',
    'en-US': 'WeChat Channels',
    'zh-CN': '微信视频号',
  },
  [PlatType.KWAI]: {
    'en': 'Kwai',
    'en-US': 'Kwai',
    'zh-CN': '快手',
  },
  [PlatType.BILIBILI]: {
    'en': 'Bilibili',
    'en-US': 'Bilibili',
    'zh-CN': '哔哩哔哩',
  },
  [PlatType.Baijiahao]: {
    'en': 'Baijiahao',
    'en-US': 'Baijiahao',
    'zh-CN': '百家号',
  },
  [PlatType.Alipay]: {
    'en': 'Alipay',
    'en-US': 'Alipay',
    'zh-CN': '支付宝生活号',
  },
  [PlatType.Weibo]: {
    'en': 'Weibo',
    'en-US': 'Weibo',
    'zh-CN': '微博',
  },
  [PlatType.Hupu]: {
    'en': 'Hupu',
    'en-US': 'Hupu',
    'zh-CN': '虎扑',
  },
  [PlatType.Xianyu]: {
    'en': 'Xianyu',
    'en-US': 'Xianyu',
    'zh-CN': '闲鱼',
  },
  [PlatType.WxGzh]: {
    'en': 'WeChat Official Account',
    'en-US': 'WeChat Official Account',
    'zh-CN': '微信公众号',
  },
}

const CHINESE_UNTRANSLATED_NAME_ALIASES: Partial<Record<PlatType, Set<string>>> = {
  [PlatType.Douyin]: new Set(['douyin']),
  [PlatType.Xhs]: new Set(['rednote', 'xiaohongshu', 'xhs']),
  [PlatType.WxSph]: new Set(['wechat channels', 'wechat channel', 'wxsph']),
  [PlatType.KWAI]: new Set(['kwai']),
  [PlatType.BILIBILI]: new Set(['bilibili']),
  [PlatType.Xianyu]: new Set(['xianyu', 'goofish']),
  [PlatType.WxGzh]: new Set(['wechat official account', 'wechat official accounts', 'wxgzh']),
}

function getNumberFromRules(rules: PlatformMediaRules, key: string) {
  const value = rules[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getOptionalNumber(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function isPlatType(value: string): value is PlatType {
  return platformValues.has(value)
}

export function isTaskPlatformSupported(platType: PlatType) {
  return !TASK_EXCLUDED_PLATFORMS.has(platType)
}

/**
 * 平台是否属于频道平台白名单（与「添加频道」可连接的平台同一份清单）。
 *
 * @param platType - 平台类型。
 * @returns 该平台可在频道管理里连接、可作为内容创作目标平台时为 true。
 */
export function isChannelPlatform(item: Pick<PlatformInfo, 'channel'> | undefined): boolean {
  return item?.channel === true
}

export function isPlatCollectSupported(platType: PlatType) {
  return !COLLECT_UNSUPPORTED_PLATFORMS.has(platType)
}

export function isPlatViewSupported(platType: PlatType) {
  return !VIEW_UNSUPPORTED_PLATFORMS.has(platType)
}

export function isPlatformAvailable<T extends Pick<PlatformInfo, 'status'>>(item?: T | null): item is T {
  return item?.status === PlatformStatus.Available
}

export function isPlatformComingSoon<T extends Pick<PlatformInfo, 'status'>>(item?: T | null): item is T {
  return item?.status === PlatformStatus.ComingSoon
}

export function isPlatformRegionLimited<T extends Pick<PlatformInfo, 'status'>>(item?: T | null): item is T {
  return item?.status === PlatformStatus.Unavailable
}

export function isPlatformVisible<T extends Pick<PlatformInfo, 'status'>>(item?: T | null): item is T {
  return !!item
}

const CHANNEL_PLATFORM_STATUS_ORDER: Record<PlatformStatus, number> = {
  [PlatformStatus.Available]: 0,
  [PlatformStatus.Unavailable]: 1,
  [PlatformStatus.ComingSoon]: 2,
}

function getChannelPlatformStatusOrder(item: Pick<PlatformInfo, 'status'>) {
  return CHANNEL_PLATFORM_STATUS_ORDER[item.status]
}

function compareChannelPlatformStatus(left: PlatformInfo, right: PlatformInfo) {
  return getChannelPlatformStatusOrder(left) - getChannelPlatformStatusOrder(right)
}

export function getPlatformDisplayName(item: PlatformMetadataVo, lng: string) {
  if (isChineseLanguage(lng)) {
    const displayName = getDisplayNameByLocale(item, ['zh-CN', 'zh', lng])
    const fallbackName = DEFAULT_PLATFORM_DISPLAY_NAMES[item.platform]?.['zh-CN']

    if (!displayName)
      return fallbackName ?? item.displayName['en-US'] ?? item.platform
    if (fallbackName && isUntranslatedChinesePlatformName(item.platform, displayName))
      return fallbackName

    return displayName
  }

  return getDisplayNameByLocale(item, getLocaleCandidates(lng))
    ?? getDefaultPlatformDisplayName(item.platform, lng)
    ?? item.platform
}

function getDisplayNameByLocale(item: PlatformMetadataVo, locales: string[]) {
  for (const locale of locales) {
    const value = item.displayName[locale]
    if (value)
      return value
  }

  return undefined
}

function getLocaleCandidates(lng: string) {
  const normalizedLng = lng.replace('_', '-')
  const baseLng = normalizedLng.split('-')[0]
  const candidates = [lng, normalizedLng, baseLng]

  if (baseLng === 'en')
    candidates.push('en-US')
  candidates.push('en-US', 'zh-CN')

  return Array.from(new Set(candidates))
}

function getDefaultPlatformDisplayName(platform: PlatType, lng: string) {
  const defaultNames = DEFAULT_PLATFORM_DISPLAY_NAMES[platform]
  if (!defaultNames)
    return undefined

  const candidates = isChineseLanguage(lng) ? ['zh-CN'] : getLocaleCandidates(lng)
  for (const locale of candidates) {
    const value = defaultNames[locale]
    if (value)
      return value
  }

  return undefined
}

function getLocalizedPlatformText(values: PlatformMetadataVo['authInstructions'], lng: string) {
  if (!values)
    return undefined

  for (const locale of getLocaleCandidates(lng)) {
    const value = values[locale]
    if (value)
      return value
  }

  return undefined
}

function isUntranslatedChinesePlatformName(platform: PlatType, displayName: string) {
  const normalizedName = displayName.trim().toLowerCase()
  return CHINESE_UNTRANSLATED_NAME_ALIASES[platform]?.has(normalizedName) === true
}

function getPubTypeFromContentMode(mode: string) {
  switch (mode) {
    case PubType.VIDEO:
      return PubType.VIDEO
    case PubType.ImageText:
    case PublishContentMode.ImageText:
      return PubType.ImageText
    case PubType.Article:
    case PublishContentMode.Text:
      return PubType.Article
    default:
      return undefined
  }
}

function derivePubTypes(item: PlatformMetadataVo) {
  const pubTypes = new Set<PubType>()
  const modes = item.contentLimits.modes

  if (item.capabilities.publish.supported === false)
    return pubTypes

  if (!modes) {
    pubTypes.add(PubType.VIDEO)
    pubTypes.add(PubType.ImageText)
    pubTypes.add(PubType.Article)
    return pubTypes
  }

  for (const mode of modes) {
    const pubType = getPubTypeFromContentMode(mode)
    if (pubType)
      pubTypes.add(pubType)
  }

  return pubTypes
}

export function normalizePlatformMetadata(item: PlatformMetadataVo, lng: string): PlatformInfo {
  const maxImages = item.contentLimits.maxImages ?? getNumberFromRules(item.mediaRules, 'maxImages')
  const titleMax = getOptionalNumber(item.contentLimits.maxTitleLength)
  const topicMax = item.topic.supported ? getOptionalNumber(item.topic.maxCount) : 0
  const topicMaxTotalLength = getOptionalNumber(item.topic.maxTotalLength)
    ?? getOptionalNumber(item.contentLimits.maxTotalTextLength)

  return {
    type: item.platform,
    platform: item.platform,
    status: item.status,
    // 服务端没下发（旧版本接口）时按"不是频道"处理：宁可少显示，也不要宣称未接入的能力。
    channel: item.channel === true,
    name: getPlatformDisplayName(item, lng),
    // 本地静态图标优先（桌面端 file:// 必须绝对化），远端 logoUrl 仅作兜底
    icon: resolveAsset(getStaticPlatformIcon(item.platform)) || item.logoUrl || '',
    logoUrl: resolveAsset(getStaticPlatformIcon(item.platform)) || item.logoUrl || '',
    authType: item.authType,
    authInstruction: getLocalizedPlatformText(item.authInstructions, lng),
    editor: item.editor,
    capabilities: item.capabilities,
    contentLimits: item.contentLimits,
    mediaRules: item.mediaRules,
    topic: item.topic,
    optionSchema: item.optionSchema,
    defaultOption: item.defaultOption,
    commonPubParamsConfig: {
      titleMax,
      topicMax,
      topicMaxTotalLength,
      desMax: item.contentLimits.maxBodyLength ?? 0,
      imagesMax: maxImages,
    },
    pubTypes: derivePubTypes(item),
  }
}

export function normalizePlatformMetadataList(items: PlatformMetadataVo[], lng: string) {
  const list = items.map(item => normalizePlatformMetadata(item, lng))
  const map = new Map<PlatType, PlatformInfo>()
  list.forEach((item) => {
    map.set(item.type, item)
  })

  return { list, map }
}

export function platformInfoListToTuples(list: PlatformInfo[]): PlatformInfoTuple[] {
  return list.map(item => [item.type, item])
}

export function getEnabledPlatformInfos(list: PlatformInfo[]) {
  return list.filter(item => isPlatformAvailable(item) && DOMESTIC_PLATFORMS.includes(item.type))
}

export function getTaskPlatformInfos(list: PlatformInfo[]) {
  return list.filter(item => isPlatformAvailable(item) && DOMESTIC_PLATFORMS.includes(item.type) && isTaskPlatformSupported(item.type))
}

/**
 * 内容创作目标平台：引擎支持且属于频道平台白名单。
 *
 * 与「添加频道」页面的平台清单对齐，避免出现"选了却发不出去"的平台。
 *
 * @param list - 平台元数据列表。
 * @returns 可直接作为内容创作目标平台的平台列表。
 */
export function getTaskChannelPlatformInfos(list: PlatformInfo[]) {
  // 能连上还不够，必须真能发出去：只接通登录、还没接通发布的平台不能当内容创作的目标平台，
  // 否则用户选了平台、点了发布，最后拿到的是"该平台暂未接入统一发布引擎"。
  return getTaskPlatformInfos(list)
    .filter(item => item.capabilities.publish.supported === true)
    .filter(item => isChannelPlatform(item))
}

export function getPublishPlatformInfos(list: PlatformInfo[]) {
  return list.filter(item => isPlatformAvailable(item) && DOMESTIC_PLATFORMS.includes(item.type) && item.capabilities.publish.supported !== false && item.pubTypes.size > 0)
}

export function getChannelPlatformInfos(list: PlatformInfo[]) {
  return list
    .filter(item => isPlatformVisible(item) && DOMESTIC_PLATFORMS.includes(item.type))
    .map((item, index) => ({ item, index }))
    .sort((left, right) => compareChannelPlatformStatus(left.item, right.item) || left.index - right.index)
    .map(({ item }) => item)
}
