'use client'

import type { ChangeEvent, RefObject } from 'react'
import type { MediaMentionItem } from '../MediaMentionPromptInput'
import type { IUploadedMedia } from '@web/components/Chat/MediaUpload'
import { Loader2, Maximize2, RotateCcw, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { apiEnhancePrompt } from '@web/api/ai/ai.api'
import { toast } from '@web/utils/ui/toast'
import ImageStack from '../ImageStack'
import MediaMentionPromptInput from '../MediaMentionPromptInput'

interface PromptComposerLabels {
  missingMedia: string
  emptyMedia: string
  emptyMediaHint: string
  loading: string
  uploadMedia: string
  resetConfig: string
  openPromptEditor: string
  enhancePrompt: string
}

interface PromptComposerProps {
  uploadInputRef: RefObject<HTMLInputElement>
  mediaAccept: string
  localMedias: IUploadedMedia[]
  /** 这次是图文还是视频：决定增强按钮走官方哪一套口径。 */
  contentType: 'video' | 'image_text'
  canUploadImage: boolean
  canUploadVideo: boolean
  canUploadAudio: boolean
  promptValue: string
  placeholder: string
  maxLength: number
  mediaMentions: MediaMentionItem[]
  labels: PromptComposerLabels
  onUploadInputChange: (event: ChangeEvent<HTMLInputElement>) => void
  onLocalMediaRemove: (index: number) => void
  onLocalUpload: (files: FileList) => void
  onPromptChange: (value: string) => void
  onPasteFiles: (files: FileList) => void
  onRequestUpload: () => void
  onReset: () => void
  onOpenPromptEditor: () => void
  onClear: () => void
}

export function PromptComposer({
  uploadInputRef,
  mediaAccept,
  localMedias,
  contentType,
  canUploadImage,
  canUploadVideo,
  canUploadAudio,
  promptValue,
  placeholder,
  maxLength,
  mediaMentions,
  labels,
  onUploadInputChange,
  onLocalMediaRemove,
  onLocalUpload,
  onPromptChange,
  onPasteFiles,
  onRequestUpload,
  onReset,
  onOpenPromptEditor,
  onClear,
}: PromptComposerProps) {
  const [enhancing, setEnhancing] = useState(false)
  // 图片与视频的增强口径不同：图像要按官方结构（文生图 / 图生图 / 多图合成）补全，
  // 参考图张数决定用哪一套——所以这里把"这次带了几张图"一起交给后端。
  const imageCount = localMedias.filter(item => item.type === 'image').length

  /**
   * 专业提示词增强：把用户写的画面要求交给大模型补齐人群、场景、镜头与画质维度。
   *
   * 只改输入框里的文本，不直接生成——用户看清增强结果、确认或再改一遍之后才去生成。
   * 大模型不可用时如实报错，绝不拿本地模板糊一个假的"增强版"填进去。
   */
  const handleEnhance = async () => {
    const raw = promptValue.trim()
    if (raw === '' || enhancing) return
    setEnhancing(true)
    try {
      const res = await apiEnhancePrompt(raw, {
        kind: contentType === 'image_text' ? 'image' : 'video',
        referenceCount: imageCount,
      })
      const enhanced = res?.data?.prompt ?? ''
      if (res?.code !== 0 || enhanced === '') {
        toast.error(res?.message || '提示词增强失败，请稍后再试')
        return
      }
      onPromptChange(enhanced)
      toast.success('已增强：可在输入框里继续修改，确认后再生成')
    }
    catch {
      toast.error('提示词增强失败，请检查「设置 → 配置大模型」')
    }
    finally {
      setEnhancing(false)
    }
  }

  return (
    <>
      <input
        ref={uploadInputRef}
        type="file"
        accept={mediaAccept}
        multiple
        className="hidden"
        onChange={onUploadInputChange}
      />

      <div className="flex flex-col items-stretch gap-3 p-4 pb-2 @min-[640px]:flex-row @min-[640px]:items-start">
        <div className="w-full shrink-0 pt-1 @min-[640px]:w-auto">
          <ImageStack
            localMedias={localMedias}
            onLocalMediaRemove={onLocalMediaRemove}
            onLocalUpload={onLocalUpload}
            canUploadImage={canUploadImage}
            canUploadVideo={canUploadVideo}
            canUploadAudio={canUploadAudio}
            accept={mediaAccept}
          />
        </div>
        <div className="relative w-full @min-[640px]:min-w-0 @min-[640px]:flex-1">
          <MediaMentionPromptInput
            testId="draftbox-ai-prompt-input"
            value={promptValue}
            placeholder={placeholder}
            maxLength={maxLength}
            mediaMentions={mediaMentions}
            onChange={onPromptChange}
            onPasteFiles={onPasteFiles}
            onRequestUpload={onRequestUpload}
            missingMediaLabel={labels.missingMedia}
            emptyMediaLabel={labels.emptyMedia}
            emptyMediaHintLabel={labels.emptyMediaHint}
            loadingLabel={labels.loading}
            uploadMediaLabel={labels.uploadMedia}
            editorClassName="min-h-[80px] max-h-[160px] overflow-auto pr-12 text-sm @min-[640px]:min-h-[100px]"
            placeholderClassName="pr-12 text-sm"
            minRows={3}
          />
          <div className="absolute top-0 right-4 z-10 flex flex-col items-center gap-0.5">
            <button
              data-testid="draftbox-ai-enhance-btn"
              type="button"
              disabled={enhancing || promptValue.trim() === ''}
              className="cursor-pointer rounded-lg p-1.5 text-primary transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => { void handleEnhance() }}
              title={labels.enhancePrompt}
              aria-label={labels.enhancePrompt}
            >
              {enhancing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            </button>
            <button
              data-testid="draftbox-ai-reset-btn"
              type="button"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"
              onClick={onReset}
              title={labels.resetConfig}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              data-testid="draftbox-ai-open-prompt-editor-btn"
              type="button"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"
              onClick={onOpenPromptEditor}
              title={labels.openPromptEditor}
            >
              <Maximize2 className="h-4 w-4" />
            </button>
            {promptValue && (
              <button
                data-testid="draftbox-ai-clear-btn"
                type="button"
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer transition-colors"
                onClick={onClear}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
