import type { StaticImageData } from '@web/next-shims/image'
import { PlatType } from '@web/app/config/platConfig'
// 百家号 / 支付宝生活号 / 微博 / 虎扑暂无官方图源：用品牌色 + 平台首字占位，替换只需换这几个文件。
import alipayIcon from '@web/assets/svgs/plat/alipay.svg?url'
import baijiahaoIcon from '@web/assets/svgs/plat/baijiahao.svg?url'
import bilibiliIcon from '@web/assets/svgs/plat/bilibili.svg?url'
import douyinIcon from '@web/assets/svgs/plat/douyin.svg?url'
import hupuIcon from '@web/assets/svgs/plat/hupu.svg?url'
import ksIcon from '@web/assets/svgs/plat/ks.svg?url'
import weiboIcon from '@web/assets/svgs/plat/weibo.svg?url'
import wxSphIcon from '@web/assets/svgs/plat/wx-sph.svg?url'
import xhsIcon from '@web/assets/svgs/plat/xhs.svg?url'
import xianyuIcon from '@web/assets/svgs/plat/xianyu.svg?url'

type StaticPlatformIconAsset = string | StaticImageData

const STATIC_PLATFORM_ICON_MAP: Record<PlatType, StaticPlatformIconAsset> = {
  [PlatType.Douyin]: douyinIcon,
  [PlatType.Xhs]: xhsIcon,
  [PlatType.WxSph]: wxSphIcon,
  [PlatType.KWAI]: ksIcon,
  [PlatType.BILIBILI]: bilibiliIcon,
  [PlatType.Baijiahao]: baijiahaoIcon,
  [PlatType.Alipay]: alipayIcon,
  [PlatType.Weibo]: weiboIcon,
  [PlatType.Hupu]: hupuIcon,
  [PlatType.Xianyu]: xianyuIcon,
}

function getStaticAssetSrc(asset: StaticPlatformIconAsset) {
  return typeof asset === 'string' ? asset : asset.src
}

export function getStaticPlatformIcon(platType?: PlatType | null) {
  if (!platType)
    return undefined

  return getStaticAssetSrc(STATIC_PLATFORM_ICON_MAP[platType])
}
