/**
 * platformCompatibility - 平台兼容性检查
 * 根据 AI 生成参数（内容类型、视频比例、时长、图片数量）自动检测不兼容平台
 */

import type { TFunction } from 'i18next'
import type { DraftContentType } from '@web/api/ai/ai.types'
import type { PlatType } from '@web/app/config/platConfig'
import { PubType } from '@web/app/config/publishConfig'

import { getPlatformInfoSync } from '@web/store/platformMetadata'

/** 视频类别约束 */
interface VideoCategory {
  /** 类别名称，仅用于日志 */
  name: string
  /** 比例范围 [min, max]，null 表示无约束 */
  aspectRatioRange: [number, number] | null
  /** 时长范围 [min, max] 秒，null 表示无约束 */
  durationRange: [number, number] | null
}

/** 平台约束配置 */
interface PlatformConstraint {
  /** 视频类别列表，任一类别兼容即视为兼容 */
  videoCategories: VideoCategory[]
  /** 图文模式最大图片数，undefined 表示不支持图文 */
  imagesMax?: number
}

/**
 * 平台约束映射表：比例与时长限制。
 *
 * 这里原先只登记了 instagram / tiktok / facebook / threads / pinterest / youtube /
 * twitter / linkedin 八个国外平台，而调用方传进来的 availablePlatforms 只会是国内平台，
 * 所以整张表从来没命中过任何一次判断——约束一直走的是 contentLimits 那条路。
 * 国外平台已从产品移除，条目一并清掉；国内平台的比例/时长约束尚未取得可核查的官方数据，
 * 拿到后再按平台补，不先写猜测值。
 *
 * 表里没有的平台按「兼容」处理（见 checkPlatformCompatibility 的约定）。
 */
const PLATFORM_CONSTRAINTS: Partial<Record<PlatType, PlatformConstraint>> = {}

/** 将比例标签转为数值："9:16" → 0.5625 */
function aspectRatioLabelToNumeric(label: string): number | null {
  const parts = label.split(':')
  if (parts.length !== 2)
    return null
  const w = Number(parts[0])
  const h = Number(parts[1])
  if (!w || !h)
    return null
  return w / h
}

/** 将秒数格式化为可读时长：3 → "3s"，90 → "1min30s"，14400 → "4h" */
function formatDuration(seconds: number): string {
  if (seconds < 60)
    return `${seconds}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) {
    if (m === 0 && s === 0)
      return `${h}h`
    if (s === 0)
      return `${h}h${m}min`
    return `${h}h${m}min${s}s`
  }
  if (s === 0)
    return `${m}min`
  return `${m}min${s}s`
}

/** 常见比例数值到标签的映射 */
const KNOWN_RATIOS: [number, string][] = [
  [16 / 9, '16:9'],
  [9 / 16, '9:16'],
  [4 / 5, '4:5'],
  [4 / 3, '4:3'],
  [3 / 4, '3:4'],
  [1, '1:1'],
  [21 / 9, '21:9'],
  [3 / 2, '3:2'],
  [2 / 3, '2:3'],
]

/** 将数值比例转为可读标签：0.5625 → "9:16" */
function numericRatioToLabel(value: number): string {
  for (const [num, label] of KNOWN_RATIOS) {
    if (Math.abs(value - num) < 0.001)
      return label
  }
  return value.toFixed(2)
}

export interface CompatibilityCheckParams {
  contentType: DraftContentType
  aspectRatio: string
  duration: number
  imageCount: number
}

/**
 * 检查各平台与当前生成参数的兼容性
 * @returns Map<PlatType, string[]>，value 为不兼容原因列表；不在 Map 中的平台视为兼容
 */
export function checkPlatformCompatibility(
  params: CompatibilityCheckParams,
  availablePlatforms: PlatType[],
  t: TFunction,
): Map<PlatType, string[]> {
  const result = new Map<PlatType, string[]>()
  const { contentType, aspectRatio, duration, imageCount } = params
  const isVideoMode = contentType === 'video'

  for (const plat of availablePlatforms) {
    const reasons: string[] = []
    const platInfo = getPlatformInfoSync(plat)
    if (!platInfo)
      continue

    if (isVideoMode) {
      // 检查平台是否支持视频
      if (!platInfo.pubTypes.has(PubType.VIDEO)) {
        reasons.push(t('detail.platformIncompatible.contentTypeNotSupported'))
      }
      else {
        // 检查视频约束（比例 + 时长）
        const constraint = PLATFORM_CONSTRAINTS[plat]
        if (constraint && constraint.videoCategories.length > 0) {
          const ratio = aspectRatioLabelToNumeric(aspectRatio)
          // 检查是否至少有一个视频类别兼容
          const anyCompatible = constraint.videoCategories.some((cat) => {
            // 检查比例
            if (cat.aspectRatioRange && ratio !== null) {
              if (ratio < cat.aspectRatioRange[0] - 0.001 || ratio > cat.aspectRatioRange[1] + 0.001) {
                return false
              }
            }
            // 检查时长
            if (cat.durationRange) {
              if (duration < cat.durationRange[0] || duration > cat.durationRange[1]) {
                return false
              }
            }
            return true
          })

          if (!anyCompatible) {
            // 判断具体原因
            const ratioValue = ratio
            const hasRatioIssue = ratioValue !== null && constraint.videoCategories.every((cat) => {
              if (!cat.aspectRatioRange)
                return false
              return ratioValue < cat.aspectRatioRange[0] - 0.001 || ratioValue > cat.aspectRatioRange[1] + 0.001
            })
            const hasDurationIssue = constraint.videoCategories.every((cat) => {
              if (!cat.durationRange)
                return false
              return duration < cat.durationRange[0] || duration > cat.durationRange[1]
            })

            if (hasRatioIssue) {
              const supportedRanges = constraint.videoCategories
                .filter(c => c.aspectRatioRange)
                .map(c => `${numericRatioToLabel(c.aspectRatioRange![0])}~${numericRatioToLabel(c.aspectRatioRange![1])}`)
              const uniqueRanges = [...new Set(supportedRanges)]
              reasons.push(t('detail.platformIncompatible.aspectRatioNotSupported', {
                current: aspectRatio,
                supported: uniqueRanges.join(', '),
              }))
            }
            if (hasDurationIssue) {
              const allRanges = constraint.videoCategories
                .filter(c => c.durationRange)
                .map(c => c.durationRange!)
              const minDuration = Math.min(...allRanges.map(r => r[0]))
              const maxDuration = Math.max(...allRanges.map(r => r[1]))
              reasons.push(t('detail.platformIncompatible.durationOutOfRange', {
                current: formatDuration(duration),
                min: formatDuration(minDuration),
                max: formatDuration(maxDuration),
              }))
            }
            // 如果以上都没判断出来（交叉不兼容），给通用提示
            if (reasons.length === 0) {
              const supportedRanges = constraint.videoCategories
                .filter(c => c.aspectRatioRange)
                .map(c => `${numericRatioToLabel(c.aspectRatioRange![0])}~${numericRatioToLabel(c.aspectRatioRange![1])}`)
              const uniqueRanges = [...new Set(supportedRanges)]
              const allDurationRanges = constraint.videoCategories
                .filter(c => c.durationRange)
                .map(c => c.durationRange!)
              const minDuration = Math.min(...allDurationRanges.map(r => r[0]))
              const maxDuration = Math.max(...allDurationRanges.map(r => r[1]))
              if (uniqueRanges.length > 0) {
                reasons.push(t('detail.platformIncompatible.aspectRatioNotSupported', {
                  current: aspectRatio,
                  supported: uniqueRanges.join(', '),
                }))
              }
              if (allDurationRanges.length > 0) {
                reasons.push(t('detail.platformIncompatible.durationOutOfRange', {
                  current: formatDuration(duration),
                  min: formatDuration(minDuration),
                  max: formatDuration(maxDuration),
                }))
              }
            }
          }
        }
      }
    }
    else {
      // 图文模式
      if (!platInfo.pubTypes.has(PubType.ImageText)) {
        reasons.push(t('detail.platformIncompatible.contentTypeNotSupported'))
      }
      else {
        // 检查图片数量
        const constraint = PLATFORM_CONSTRAINTS[plat]
        const maxImages = constraint?.imagesMax ?? platInfo.commonPubParamsConfig.imagesMax
        if (maxImages !== undefined && imageCount > maxImages) {
          reasons.push(t('detail.platformIncompatible.imageCountExceeded', { max: maxImages }))
        }
      }
    }

    if (reasons.length > 0) {
      result.set(plat, reasons)
    }
  }

  return result
}
