import type { CSSProperties, ImgHTMLAttributes } from 'react'

interface NextImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src: string
  alt: string
  overrideSrc?: string
  width?: number | string
  height?: number | string
  fill?: boolean
  priority?: boolean
  quality?: number
  unoptimized?: boolean
  sizes?: string
  loader?: unknown
  placeholder?: string
  blurDataURL?: string
  style?: CSSProperties
}

export interface ImageLoaderProps {
  src: string
  width?: number
  quality?: number
}

export interface ImageProps extends NextImageProps {}

export type ImageLoader = (props: ImageLoaderProps) => string

export interface StaticImageData {
  src: string
  height: number
  width: number
  blurDataURL?: string
}

export function getImageProps(props: NextImageProps) {
  const { src, alt, width, height, ...rest } = props
  return {
    props: {
      src: typeof src === 'string' ? src : src,
      alt: alt ?? '',
      width,
      height,
      ...rest,
    },
  }
}

export default function Image({
  src,
  alt,
  width,
  height,
  fill,
  style,
  unoptimized: _unoptimized,
  priority: _priority,
  quality: _quality,
  sizes: _sizes,
  loader: _loader,
  placeholder: _placeholder,
  blurDataURL: _blurDataURL,
  ...rest
}: NextImageProps) {
  const mergedStyle: CSSProperties = {
    ...(fill ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } : {}),
    ...style,
  }
  return (
    <img
      src={src}
      alt={alt}
      width={width !== undefined ? Number(width) : undefined}
      height={height !== undefined ? Number(height) : undefined}
      style={mergedStyle}
      loading="lazy"
      {...rest}
    />
  )
}
