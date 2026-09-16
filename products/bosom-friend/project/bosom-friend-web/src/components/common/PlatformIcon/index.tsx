'use client'

import type { PlatType } from '@web/app/config/platConfig'
import type { OssImageProps } from '@web/components/common/OssImage'
import { OssImage } from '@web/components/common/OssImage'
import { usePlatformInfo } from '@web/hooks/usePlatformMetadata'
import { getStaticPlatformIcon } from '@web/store/platformMetadata/staticIcons'

type PlatformIconProps = Omit<OssImageProps, 'src' | 'alt'> & {
  platform?: PlatType | null
  src?: string
  alt?: string
}

export function PlatformIcon({ platform, src, alt, width = 20, height = 20, ...props }: PlatformIconProps) {
  const platformInfo = usePlatformInfo(platform)
  const imageSrc = src ?? platformInfo?.icon ?? getStaticPlatformIcon(platform)

  if (!imageSrc)
    return null

  return (
    <OssImage
      {...props}
      src={imageSrc}
      alt={alt ?? platformInfo?.name ?? platform ?? 'platform'}
      width={width}
      height={height}
      thumbnailWidth={typeof width === 'number' ? width : undefined}
      thumbnailHeight={typeof height === 'number' ? height : undefined}
    />
  )
}

export default PlatformIcon
