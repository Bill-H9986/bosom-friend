import { useEffect, useRef } from 'react'
import { appendAgentFeedback } from '@web/utils/agentFeedback'

interface UseAutoPublishOnReadyOptions {
  enabled?: boolean
  open?: boolean
  ready: boolean
  selectedCount: number
  triggerPublish: (silent?: boolean | string) => boolean
}

export function useAutoPublishOnReady({
  enabled = false,
  open = true,
  ready,
  selectedCount,
  triggerPublish,
}: UseAutoPublishOnReadyOptions) {
  const hasTriggeredRef = useRef(false)
  const retryRef = useRef(0)

  useEffect(() => {
    if (!open) {
      hasTriggeredRef.current = false
      retryRef.current = 0
      return
    }

    if (!enabled || hasTriggeredRef.current || !ready || selectedCount !== 1)
      return

    let cancelled = false
    const attempt = () => {
      if (cancelled || hasTriggeredRef.current)
        return
      let ok = false
      try {
        ok = triggerPublish(true)
      }
      catch (error) {
        void error
        return
      }
      if (ok) {
        hasTriggeredRef.current = true
        retryRef.current = 0
        return
      }
      // 媒体元数据/上传尚未就绪：静默重试（最多 30 次，间隔 1s），
      // 避免“视频还在加载校验就触发自动发布”导致自动模式永久卡死。
      if (retryRef.current >= 30) {
        hasTriggeredRef.current = true
        void appendAgentFeedback('自动发布未就绪：媒体、账号或平台参数仍未准备好，智能体已停止自动重试，请在发布弹窗中检查后点击发布。')
        return
      }
      retryRef.current += 1
      window.setTimeout(attempt, 1000)
    }
    const timer = window.setTimeout(attempt, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enabled, open, ready, selectedCount, triggerPublish])
}
