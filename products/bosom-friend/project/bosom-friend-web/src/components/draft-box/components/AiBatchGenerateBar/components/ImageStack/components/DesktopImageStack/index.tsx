import type { CSSProperties } from 'react'
import type { DesktopImageStackProps } from '../../types'
import { Plus } from 'lucide-react'
import { cn } from '@web/utils/className'
import AddMediaButton from '../../../AddMediaButton'
import styles from '../../ImageStack.module.scss'
import { ITEM_HEIGHT, ITEM_WIDTH } from '../../utils/constants'
import { getAddButtonExpandedStyle } from '../../utils/styles'
import { MediaStackCard } from '../MediaStackCard'

export function DesktopImageStack({
  localMedias,
  showAddButton,
  uploadUnsupported,
  accept,
  totalMediaCount,
  layout,
  videoInfoMap,
  exitingKeys,
  onLocalUpload,
  onDelete,
  onPreview,
}: DesktopImageStackProps) {
  const {
    isExpanded,
    expandedContainerStyle,
    containerLeft,
    handleContainerMouseEnter,
    handleContainerMouseLeave,
    handleItemMouseEnter,
  } = layout
  const expandContainerStyle: CSSProperties = isExpanded
    ? { ...expandedContainerStyle, left: containerLeft }
    : { width: ITEM_WIDTH, height: ITEM_HEIGHT, left: containerLeft }

  return (
    <div data-testid="draftbox-ai-image-stack" className="flex items-start gap-1">
      <div className="relative w-20 h-24 flex-shrink-0">
        <div
          className={cn(styles.expandContainer, isExpanded && styles.expanded)}
          style={expandContainerStyle}
          onMouseEnter={handleContainerMouseEnter}
          onMouseLeave={handleContainerMouseLeave}
        >
          {localMedias.map((media, index) => (
            <MediaStackCard
              key={media.id || `local-${index}`}
              media={media}
              index={index}
              totalMediaCount={totalMediaCount}
              isExpanded={isExpanded}
              isMobile={false}
              videoInfo={media.id ? videoInfoMap.get(media.id) : undefined}
              exitingKeys={exitingKeys}
              onDelete={onDelete}
              onPreview={onPreview}
              onExpand={handleItemMouseEnter}
            />
          ))}
          {(showAddButton || uploadUnsupported) && (
            <div
              className={cn(
                styles.addButtonWrapper,
                isExpanded ? styles.addButtonWrapperExpanded : styles.addButtonWrapperCollapsed,
              )}
              style={isExpanded ? getAddButtonExpandedStyle(totalMediaCount) : undefined}
            >
              {uploadUnsupported ? (
                <button
                  data-testid="draftbox-ai-add-media-btn"
                  type="button"
                  disabled
                  className={cn(
                    isExpanded ? styles.addButtonExpanded : styles.addButtonCollapsed,
                    'cursor-not-allowed opacity-40',
                  )}
                  aria-label="上传素材（当前模型不支持参考素材）"
                  title="当前视频模型是纯文生视频，不支持上传参考图片/视频/音频；换成支持参考素材的模型后即可上传。"
                >
                  <Plus className={isExpanded ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
                </button>
              ) : (
                <AddMediaButton onLocalUpload={onLocalUpload} accept={accept}>
                  <button
                    data-testid="draftbox-ai-add-media-btn"
                    type="button"
                    className={isExpanded ? styles.addButtonExpanded : styles.addButtonCollapsed}
                    aria-label="上传素材"
                  >
                    <Plus className={isExpanded ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
                  </button>
                </AddMediaButton>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
