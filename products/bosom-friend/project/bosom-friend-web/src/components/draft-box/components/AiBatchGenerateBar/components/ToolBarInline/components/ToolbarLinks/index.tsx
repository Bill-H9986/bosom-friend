import type { ToolbarLinksProps } from '../../types'
import { Sparkles } from 'lucide-react'
import { dispatchOpenAiChat } from '@web/utils/bosomFriendAssistant'

export function ToolbarLinks({
  isVideoMode,
  promptsExploreLabel,
}: ToolbarLinksProps) {
  if (!isVideoMode) {
    return null
  }

  // 直接唤起右侧 AI 助手对话框（预填推荐提示词的请求）——走统一指令契约
  const openAiChat = () => {
    dispatchOpenAiChat('请帮我推荐几个适合我当前创作方向的优质提示词')
  }

  return (
    <button
      type="button"
      onClick={openAiChat}
      className="inline-flex cursor-pointer items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-brand-cyan"
    >
      {promptsExploreLabel}
      <Sparkles className="h-3 w-3" />
    </button>
  )
}
