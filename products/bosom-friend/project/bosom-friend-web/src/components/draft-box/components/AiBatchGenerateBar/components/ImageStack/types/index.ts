import type { CSSProperties, Dispatch, MouseEvent, SetStateAction } from 'react'
import type { IUploadedMedia } from '@web/components/Chat/MediaUpload'
import type { MediaPreviewItem } from '@web/components/common/MediaPreview'

export interface ImageStackProps {
  localMedias: IUploadedMedia[]
  onLocalMediaRemove: (index: number) => void
  onLocalUpload: (files: FileList) => void
  canUploadImage: boolean
  canUploadVideo: boolean
  canUploadAudio: boolean
  accept: string
}

export interface VideoInfo {
  coverUrl: string
  duration: number
}

export type ImageStackPreviewType = MediaPreviewItem['type']
export type ImageStackPreviewHandler = (
  url: string,
  type: ImageStackPreviewType,
  title?: string,
) => void
export type ImageStackDeleteHandler = (event: MouseEvent, mediaId: string) => void

export interface ImageStackLayoutState {
  isExpanded: boolean
  expandedContainerStyle: CSSProperties
  containerLeft: number
  setExpanded: Dispatch<SetStateAction<boolean>>
  clearCollapseTimer: () => void
  handleContainerMouseEnter: () => void
  handleContainerMouseLeave: () => void
  handleItemMouseEnter: () => void
}

export interface UseImageStackLayoutParams {
  totalMediaCount: number
  showAddButton: boolean
}

export interface UseImageStackRemovalParams {
  localMedias: IUploadedMedia[]
  onLocalMediaRemove: (index: number) => void
  onLastMediaRemoved: () => void
}

export interface MediaStackCardProps {
  media: IUploadedMedia
  index: number
  totalMediaCount: number
  isExpanded: boolean
  isMobile: boolean
  videoInfo?: VideoInfo
  exitingKeys: Set<string>
  onDelete: ImageStackDeleteHandler
  onPreview: ImageStackPreviewHandler
  onExpand: () => void
}

export interface MobileImageStackProps {
  localMedias: IUploadedMedia[]
  showAddButton: boolean
  /** 当前模型不支持任何参考素材：按钮保留但置灰，并给出原因（铁律 #9 第 3 条：禁止点了没反应）。 */
  uploadUnsupported: boolean
  accept: string
  videoInfoMap: Map<string, VideoInfo>
  exitingKeys: Set<string>
  onLocalUpload: (files: FileList) => void
  onDelete: ImageStackDeleteHandler
  onPreview: ImageStackPreviewHandler
}

export interface DesktopImageStackProps {
  localMedias: IUploadedMedia[]
  showAddButton: boolean
  /** 当前模型不支持任何参考素材：按钮保留但置灰，并给出原因（铁律 #9 第 3 条：禁止点了没反应）。 */
  uploadUnsupported: boolean
  accept: string
  totalMediaCount: number
  layout: ImageStackLayoutState
  videoInfoMap: Map<string, VideoInfo>
  exitingKeys: Set<string>
  onLocalUpload: (files: FileList) => void
  onDelete: ImageStackDeleteHandler
  onPreview: ImageStackPreviewHandler
}

export interface UploadProgressOverlayProps {
  progress?: number
}

export interface AudioMediaCardProps {
  name: string
}

export interface VideoMediaCardProps {
  localInfo?: VideoInfo
  videoUrl?: string
}
