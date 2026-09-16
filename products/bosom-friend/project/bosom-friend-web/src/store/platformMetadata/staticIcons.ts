import type { StaticImageData } from '@web/next-shims/image'
import { PlatType } from '@web/app/config/platConfig'
import bilibiliIcon from '@web/assets/svgs/plat/bilibili.svg?url'
import douyinIcon from '@web/assets/svgs/plat/douyin.svg?url'
import gzhIcon from '@web/assets/svgs/plat/gzh.svg?url'
import ksIcon from '@web/assets/svgs/plat/ks.svg?url'
import wxSphIcon from '@web/assets/svgs/plat/wx-sph.svg?url'
import xhsIcon from '@web/assets/svgs/plat/xhs.svg?url'
import xianyuIcon from '@web/assets/svgs/plat/xianyu.svg?url'
import genericIcon from '@web/assets/images/logo.png?url'

type StaticPlatformIconAsset = string | StaticImageData

const STATIC_PLATFORM_ICON_MAP: Record<PlatType, StaticPlatformIconAsset> = {
  [PlatType.Douyin]: douyinIcon,
  [PlatType.Xhs]: xhsIcon,
  [PlatType.WxSph]: wxSphIcon,
  [PlatType.KWAI]: ksIcon,
  [PlatType.BILIBILI]: bilibiliIcon,
  [PlatType.Baijiahao]: genericIcon,
  [PlatType.Alipay]: genericIcon,
  [PlatType.Weibo]: genericIcon,
  [PlatType.Hupu]: genericIcon,
  [PlatType.Xianyu]: xianyuIcon,
  [PlatType.WxGzh]: gzhIcon,
}

function getStaticAssetSrc(asset: StaticPlatformIconAsset) {
  return typeof asset === 'string' ? asset : asset.src
}

export function getStaticPlatformIcon(platType?: PlatType | null) {
  if (!platType)
    return undefined

  return getStaticAssetSrc(STATIC_PLATFORM_ICON_MAP[platType])
}
