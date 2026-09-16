import type { MobileImageStackProps } from '../../types'
import { Plus } from 'lucide-react'
import { cn } from '@web/utils/className'
import AddMediaButton from '../../../AddMediaButton'
import styles from '../../ImageStack.module.scss'
import { MediaStackCard } from '../MediaStackCard'

export function MobileImageStack({
  localMedias,
  showAddButton,
  uploadUnsupported,
  accept,
  videoInfoMap,
  exitingKeys,
  onLocalUpload,
  onDelete,
  onPreview,
}: MobileImageStackProps) {
  return (
    <div data-testid="draftbox-ai-image-stack" className={styles.mobileGrid}>
      {localMedias.map((media, index) => (
        <MediaStackCard
          key={media.id || index}
          media={media}
          index={index}
          totalMediaCount={localMedias.length}
          isExpanded
          isMobile
          videoInfo={media.id ? videoInfoMap.get(media.id) : undefined}
          exitingKeys={exitingKeys}
          onDelete={onDelete}
          onPreview={onPreview}
          onExpand={() => undefined}
        />
      ))}
      {(showAddButton || uploadUnsupported) && (
        uploadUnsupported ? (
          <button
            data-testid="draftbox-ai-add-media-btn"
            type="button"
            disabled
            className={cn(styles.mobileAddButton, 'cursor-not-allowed opacity-40')}
            aria-label="上传素材（当前模型不支持参考素材）"
            title="当前视频模型是纯文生视频，不支持上传参考图片/视频/音频；换成支持参考素材的模型后即可上传。"
          >
            <Plus className="h-4 w-4" />
          </button>
        ) : (
          <AddMediaButton onLocalUpload={onLocalUpload} accept={accept}>
            <button
              data-testid="draftbox-ai-add-media-btn"
              type="button"
              className={styles.mobileAddButton}
              aria-label="上传素材"
            >
              <Plus className="h-4 w-4" />
            </button>
          </AddMediaButton>
        )
      )}
    </div>
  )
}
