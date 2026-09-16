import type { StaticImageData } from '@web/next-shims/image'
import bilibiliIcon from '@web/assets/svgs/plat/bilibili.svg'
import douyinIcon from '@web/assets/svgs/plat/douyin.svg'
import gzhIcon from '@web/assets/svgs/plat/gzh.svg'
import ksIcon from '@web/assets/svgs/plat/ks.svg'
import wxSphIcon from '@web/assets/svgs/plat/wx-sph.svg'
import xhsIcon from '@web/assets/svgs/plat/xhs.svg'
// 闲鱼暂无官方图源：用同色系通用鱼形标记占位，替换只需换这一个文件。
import xianyuIcon from '@web/assets/svgs/plat/xianyu.svg'
import genericIcon from '@web/assets/images/logo.png'

/**
 * 产品支持的平台。只做国内平台：TikTok / YouTube / X / Facebook / Instagram /
 * Threads / Pinterest / LinkedIn 一律不在产品范围内，连类型都不保留，
 * 避免任何一处误把它们渲染出来。
 */
export enum PlatType {
  Douyin = 'douyin',
  Xhs = 'xhs',
  WxSph = 'wxSph',
  KWAI = 'KWAI',
  BILIBILI = 'bilibili',
  Baijiahao = 'baijiahao',
  Alipay = 'alipay',
  Weibo = 'weibo',
  Hupu = 'hupu',
  Xianyu = 'xianyu',
  WxGzh = 'wxGzh',
}

type PlatformIconAsset = string | StaticImageData

export interface AccountPlatInfo {
  name: string
  icon: string
  tips?: {
    account?: string
  }
}

function getIconSrc(asset: PlatformIconAsset) {
  return typeof asset === 'string' ? asset : asset.src
}

export const AccountPlatInfoMap = new Map<PlatType, AccountPlatInfo>([
  [PlatType.Douyin, { name: '抖音', icon: getIconSrc(douyinIcon) }],
  [PlatType.Xhs, { name: '小红书', icon: getIconSrc(xhsIcon) }],
  [PlatType.WxSph, { name: '视频号', icon: getIconSrc(wxSphIcon) }],
  [PlatType.KWAI, { name: '快手', icon: getIconSrc(ksIcon) }],
  [PlatType.BILIBILI, { name: '哔哩哔哩', icon: getIconSrc(bilibiliIcon) }],
  [PlatType.Baijiahao, { name: '百家号', icon: getIconSrc(genericIcon) }],
  [PlatType.Alipay, { name: '支付宝生活号', icon: getIconSrc(genericIcon) }],
  [PlatType.Weibo, { name: '微博', icon: getIconSrc(genericIcon) }],
  [PlatType.Hupu, { name: '虎扑', icon: getIconSrc(genericIcon) }],
  [PlatType.Xianyu, { name: '闲鱼', icon: getIconSrc(xianyuIcon) }],
  [PlatType.WxGzh, { name: '微信公众号', icon: getIconSrc(gzhIcon) }],
])

export const RegionSortedPlatInfoArr = Array.from(AccountPlatInfoMap.entries())

/**
 * 平台由开源引擎自动发现，不在这里手工维护“能不能接入”的白名单；
 * 只保留前端已有类型，未出现在这里的平台由后端能力清单决定。
 */
export const DOMESTIC_PLATFORMS: PlatType[] = [
  PlatType.Douyin,
  PlatType.Xhs,
  PlatType.KWAI,
  PlatType.WxSph,
  PlatType.BILIBILI,
  PlatType.Baijiahao,
  PlatType.Alipay,
  PlatType.Weibo,
  PlatType.Hupu,
  PlatType.Xianyu,
]

/** 国内平台信息映射 */
export const DomesticPlatInfoMap = new Map(
  DOMESTIC_PLATFORMS.map(platform => [platform, AccountPlatInfoMap.get(platform)] as const),
)

export function isPlatformAvailable(_platform: PlatType) {
  return true
}
