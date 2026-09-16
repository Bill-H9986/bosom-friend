/**
 * HomeChat - 首页Chat组件
 * 功能：大尺寸聊天输入框，使用全局 AgentStore 发起 SSE 任务，获取 taskId 后跳转到对话详情页
 */

'use client'

import { useParams, useRouter, useSearchParams } from '@web/next-shims/navigation'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@web/app/i18n/client'
import { useChannelManagerStore } from '@web/components/ChannelManager'
import { ChatInput } from '@web/components/Chat/ChatInput'
import { PlatformIcon } from '@web/components/common/PlatformIcon'
import { useMediaUpload } from '@web/hooks/useMediaUpload'
import { usePlatformInfoList } from '@web/hooks/usePlatformMetadata'
import { useAccountStore } from '@web/store/account'
import { useAgentStore } from '@web/store/agent'
import { useUserStore } from '@web/store/user'

import { navigateToLogin } from '@web/utils/auth'
import { cn } from '@web/utils/className'
import { toast } from '@web/utils/ui/toast'
import './style.css'

export interface IHomeChatProps {
  /** 登录检查回调 */
  onLoginRequired?: () => void
  /** 自定义类名 */
  className?: string
  /** 外部设置的提示词 */
  externalPrompt?: string
  /** 外部设置的素材图片列表 */
  externalMaterials?: string[]
  /** 清除外部提示词的回调 */
  onClearExternalPrompt?: () => void
  /** 从任务页面跳转带来的任务ID，优先显示在输入框 */
  agentTaskId?: string
}

/** HomeChat 组件的 ref 接口 */
export interface IHomeChatRef {
  /** 处理文件拖拽上传 */
  handleFileDrop: (files: FileList) => void
}

/**
 * HomeChat - 首页Chat组件
 */
export const HomeChat = forwardRef<IHomeChatRef, IHomeChatProps>(
  ({ onLoginRequired, className, externalPrompt, externalMaterials, onClearExternalPrompt, agentTaskId }, ref) => {
    const { t } = useTransClient('chat')
    const { t: tHome } = useTransClient('home')
    const router = useRouter()
    const platformList = usePlatformInfoList('publish')
    const { lng } = useParams()
    const token = useUserStore(state => state.token)

    // 获取默认提示文本
    const defaultPrompt
      = t('input.placeholder') || 'Help me create a cat dancing video and post it directly on YouTube'

    // 状态 - 初始为空，使用 placeholder 显示提示文本
    const [inputValue, setInputValue] = useState('')

    // 生成参数（可选，发送时自动附加到提示词）
    const [videoRatio, setVideoRatio] = useState('9:16')
    const [videoDuration, setVideoDuration] = useState('30秒')
    const [withVoice, setWithVoice] = useState(true)
    const [targetPlatforms, setTargetPlatforms] = useState<string[]>([])

    /** 将生成参数拼接为结构化提示词后缀 */
    const composePrompt = useCallback(
      (base: string) => {
        const params: string[] = []
        if (videoRatio) params.push(`视频比例：${videoRatio}`)
        if (videoDuration) params.push(`生成时长：${videoDuration}`)
        params.push(`配音：${withVoice ? '开启' : '关闭'}`)
        if (targetPlatforms.length > 0) {
          params.push(`目标平台：${targetPlatforms.join('、')}`)
        }
        if (params.length === 0) return base
        return `${base}\n\n【生成参数】\n${params.map(p => `- ${p}`).join('\n')}`
      },
      [videoRatio, videoDuration, withVoice, targetPlatforms],
    )

    // 当外部提示词或 agentTaskId 变化时更新输入框
    useEffect(() => {
      if (agentTaskId) {
        // 优先从 localStorage 读取 agentExternalPrompt（任务页可能在跳转前写入）
        let desc = ''
        try {
          const stored = localStorage.getItem('agentExternalPrompt')
          if (stored) {
            desc = stored
            localStorage.removeItem('agentExternalPrompt')
          }
        }
        catch (e) {
          // ignore
        }

        desc = externalPrompt || defaultPrompt

        setInputValue(`${desc} TaskId: ${agentTaskId}`)
        onClearExternalPrompt?.()
        return
      }

      if (externalPrompt) {
        setInputValue(externalPrompt)
      }

      // 处理外部 materials - 覆盖现有素材，并添加完整域名
      if (externalMaterials && externalMaterials.length > 0) {
        const origin = typeof window !== 'undefined' ? window.location.origin : ''
        const newMedias = externalMaterials.map((url, idx) => ({
          id: `external-${Date.now()}-${idx}`,
          url: url.startsWith('http') ? url : `${origin}${url}`,
          type: 'image' as const,
        }))
        setMedias(newMedias) // 覆盖而非追加
      }

      if (externalPrompt || (externalMaterials && externalMaterials.length > 0)) {
        onClearExternalPrompt?.()
      }
    }, [externalPrompt, externalMaterials, onClearExternalPrompt, agentTaskId])
    const [isSubmitting, setIsSubmitting] = useState(false)

    // 频道管理器
    const { openConnectList } = useChannelManagerStore(
      useShallow(state => ({
        openConnectList: state.openConnectList,
      })),
    )

    // 处理添加账号点击 - 未登录时跳转登录页
    const handleAddChannelClick = useCallback(() => {
      if (!token) {
        navigateToLogin()
        return
      }
      openConnectList()
    }, [token, openConnectList])

    // 使用媒体上传 Hook
    const {
      medias,
      setMedias,
      isUploading,
      handleMediasChange,
      handleMediaRemove,
      handleMediaUpdate,
      clearMedias,
    } = useMediaUpload({
      onError: () => toast.error(t('media.uploadFailed')),
    })

    // 暴露方法给父组件（用于全屏拖拽上传）
    useImperativeHandle(
      ref,
      () => ({
        handleFileDrop: (files: FileList) => {
          handleMediasChange(files)
        },
      }),
      [handleMediasChange],
    )

    const searchParams = useSearchParams()

    useEffect(() => {
      try {
        if (!searchParams)
          return

        // 处理从品牌推广页跳转来的参数
        const promptParam = searchParams.get('prompt')

        if (promptParam) {
          setInputValue(decodeURIComponent(promptParam))
          // 清理 URL 参数
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href)
            url.searchParams.delete('prompt')
            window.history.replaceState({}, '', url.toString())
          }
        }

        // 处理 AI 生成分享的参数
        const aiGenerated = searchParams.get('aiGenerated')
        if (aiGenerated === 'true') {
          const mediasParam = searchParams.get('medias')
          const descriptionParam = searchParams.get('description')
          if (descriptionParam) {
            setInputValue(decodeURIComponent(descriptionParam) || defaultPrompt)
          }
          if (mediasParam) {
            try {
              const medias = JSON.parse(decodeURIComponent(mediasParam))
              if (Array.isArray(medias) && medias.length > 0) {
                setMedias(prev => [
                  {
                    id: `shared-${Date.now()}`,
                    url: medias[0].url,
                    type: 'image',
                    file: undefined,
                  },
                  ...prev,
                ])
              }
            }
            catch (e) {
              // ignore parse errors
            }
          }
          // remove params to avoid re-processing (replaceState)
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href)
            url.searchParams.delete('aiGenerated')
            url.searchParams.delete('medias')
            url.searchParams.delete('description')
            window.history.replaceState({}, '', url.toString())
          }
        }
      }
      catch (e) {
        // ignore
      }
    }, [searchParams])

    // 全局 Store
    const { setPendingTask, setActionContext } = useAgentStore()

    /**
     * 设置 Action 上下文（用于处理任务结果的 action）
     */
    useEffect(() => {
      setActionContext({
        router,
        lng: lng as string,
        t: tHome,
      })
    }, [router, lng, tHome, setActionContext])

    /** 实际执行发送的函数 */
    const doSend = useCallback(() => {
      // 如果用户没有输入，使用占位符文案
      const actualPrompt = composePrompt(inputValue.trim() || defaultPrompt)

      // 保存当前输入
      const currentPrompt = actualPrompt
      const currentMedias = [...medias]

      // 设置 loading 状态，保留输入内容让用户知道正在处理
      setIsSubmitting(true)

      // 将任务存入 store，立即跳转
      setPendingTask({
        prompt: currentPrompt,
        medias: currentMedias,
      })

      // 立即跳转到聊天页面（使用 "new" 作为临时 taskId）
      router.push(`/chat/new`)
    }, [inputValue, medias, router, lng, setPendingTask, composePrompt])

    /** 处理发送消息 */
    const handleSend = useCallback(async () => {
      // 检查登录状态 - 未登录时存储 pendingTask 后跳转登录页
      if (!token) {
        // 如果用户没有输入，使用占位符文案
        const actualPrompt = composePrompt(inputValue.trim() || defaultPrompt)
        sessionStorage.setItem('pendingTask', JSON.stringify({ prompt: actualPrompt, medias }))
        navigateToLogin(`/chat/new`)
        return
      }

      // 余额不足检查 - 阈值 50（美分）与 LowBalanceAlertProvider 中的 BALANCE_THRESHOLD 一致
      const creditsBalance = useUserStore.getState().creditsBalance
      if (creditsBalance < 50) {
        useAccountStore.getState().setLowBalanceAlertOpen(true)
        return
      }

      // 执行发送逻辑
      doSend()
    }, [token, doSend, inputValue, defaultPrompt, medias, lng, composePrompt])

    return (
      <div className={cn('w-full', className)}>
        {/* 标题区域 */}
        <div className="text-center mb-5 px-4">
          <h1 className="text-xl text-foreground font-semibold">
            {tHome('agentGenerator.subtitle')}
          </h1>
        </div>

        {/* 左右分栏：左侧创作输入（约 70%），右侧生成参数（约 30%） */}
        <div className="flex flex-col lg:flex-row items-stretch gap-4">
          {/* 左侧：创作输入区 */}
          <div className="flex-1 min-w-0">
            <ChatInput
              value={inputValue}
              onChange={setInputValue}
              onSend={handleSend}
              medias={medias}
              onMediasChange={handleMediasChange}
              onMediaRemove={handleMediaRemove}
              onMediaUpdate={handleMediaUpdate}
              isGenerating={isSubmitting}
              isUploading={isUploading}
              placeholder={defaultPrompt}
              mode="large"
              allowEmptySubmit
            />

            {/* 媒体上传规则提示（官网同款：视频/音频/图片数量与 @ 引用说明） */}
            <div className="mb-2 px-1 text-xs text-muted-foreground/80 leading-relaxed">
              最多上传 3 段视频素材（总时长不超过 15 秒）、3 个音频素材（总时长不超过 15 秒）、9 张图片素材；在提示词输入
              <span className="px-1 font-semibold text-[#a78bfa]">@</span>
              可引用已上传的媒体资源
            </div>

            {/* 平台工具链接提示（与输入卡片无缝衔接） */}
            <div
              className="flex items-center gap-3 mb-2 cursor-pointer rounded-b-2xl border border-t-0 border-border bg-muted/50 pt-4 pb-3 px-4 -mt-3 transition-colors hover:bg-muted"
              onClick={handleAddChannelClick}
            >
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {t('home.connectTools')}
              </span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {platformList.map(platformInfo => (
                  <PlatformIcon
                    platform={platformInfo.type}
                    key={platformInfo.type}
                    width={24}
                    height={24}
                    className="w-6 h-6 rounded-full object-contain hover:scale-110 hover:opacity-80 transition-all"
                    title={platformInfo.name}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* 右侧：生成参数面板（固定 320px，随父容器等高拉伸） */}
          <div className="lg:w-[320px] lg:max-w-[320px] shrink-0">
            <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-baseline justify-between mb-5">
                <h3 className="text-[15px] font-semibold text-foreground">
                  生成参数
                </h3>
                <span className="text-[11px] text-muted-foreground">
                  可选 · 自动附加给 AI
                </span>
              </div>

              {/* 视频比例 */}
              <div className="mb-5">
                <label className="block text-xs text-muted-foreground mb-2">
                  视频比例
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {['9:16', '16:9', '1:1'].map(ratio => (
                    <button
                      key={ratio}
                      type="button"
                      onClick={() => setVideoRatio(ratio)}
                      className={cn(
                        'h-8 rounded-lg border text-xs font-medium transition-all cursor-pointer',
                        videoRatio === ratio
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-primary/40',
                      )}
                    >
                      {ratio === '9:16' ? '9:16 竖屏' : ratio === '16:9' ? '16:9 横屏' : '1:1 方形'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 生成时长 */}
              <div className="mb-5">
                <label className="block text-xs text-muted-foreground mb-2">
                  生成时长
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {['15秒', '30秒', '60秒'].map(duration => (
                    <button
                      key={duration}
                      type="button"
                      onClick={() => setVideoDuration(duration)}
                      className={cn(
                        'h-8 rounded-lg border text-xs font-medium transition-all cursor-pointer',
                        videoDuration === duration
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-primary/40',
                      )}
                    >
                      {duration}
                    </button>
                  ))}
                </div>
              </div>

              {/* 配音开关 */}
              <div className="mb-5">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">
                    AI 配音
                  </label>
                  <button
                    type="button"
                    onClick={() => setWithVoice(v => !v)}
                    className={cn(
                      'relative h-6 w-11 rounded-full transition-colors cursor-pointer',
                      withVoice ? 'bg-primary' : 'bg-muted',
                    )}
                    aria-pressed={withVoice}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
                        withVoice ? 'left-[22px]' : 'left-0.5',
                      )}
                    />
                  </button>
                </div>
              </div>

              {/* 目标平台 */}
              <div>
                <label className="block text-xs text-muted-foreground mb-2">
                  目标平台（可多选）
                </label>
                <div className="flex flex-wrap gap-2">
                  {platformList.map(platformInfo => {
                    const active = targetPlatforms.includes(platformInfo.type)
                    return (
                      <button
                        key={platformInfo.type}
                        type="button"
                        onClick={() =>
                          setTargetPlatforms(prev =>
                            active
                              ? prev.filter(p => p !== platformInfo.type)
                              : [...prev, platformInfo.type],
                          )}
                        className={cn(
                          'btn btn-sm rounded-full',
                          active
                            ? 'btn-secondary border-primary/50 text-primary'
                            : 'btn-outline text-muted-foreground hover:border-primary/40',
                        )}
                      >
                        <PlatformIcon
                          platform={platformInfo.type}
                          width={16}
                          height={16}
                          className="w-4 h-4 rounded-full object-contain"
                        />
                        {platformInfo.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  },
)

export default HomeChat
