/**
 * AI 社媒内容组件 - AI social media Page Content
 * 客户端组件，包含所有交互逻辑
 */
'use client'

import type { IHomeChatRef } from './components/HomeChat'
import { ArrowUp, Upload } from 'lucide-react'
import { useParams, useRouter, useSearchParams } from '@web/next-shims/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@web/components/ui/button'
import { useAgentStore } from '@web/store/agent'
import { cn } from '@web/utils/className'
import { toast } from '@web/utils/ui/toast'
import { useTransClient } from '../../i18n/client'
import AgentFeatures from './components/AgentFeatures'
import EcosystemDiagram from './components/EcosystemDiagram'
import { HomeChat } from './components/HomeChat'
import { LogoParticleField } from '@web/components/effects/LogoParticleField'
import PromptGallery from './components/PromptGallery'
import TaskPreview from './components/TaskPreview'
import Image from '@web/next-shims/image'
import logo from '@web/assets/images/logo.png'

export function AiSocialPageContent({ introMode = false }: { introMode?: boolean }) {
  const { t } = useTransClient('home')

  // Store 方法
  const { setDebugFiles } = useAgentStore()

  // 拖拽上传状态
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)
  const homeChatRef = useRef<IHomeChatRef>(null)

  // 拖拽事件处理
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    dragCounterRef.current = 0

    const files = e.dataTransfer.files
    if (files.length > 0) {
      homeChatRef.current?.handleFileDrop(files)
    }
  }, [])

  /**
   * 回到顶部按钮组件
   * @param position 按钮位置，'left' 或 'right'
   */
  function BackToTop({ position = 'left' }: { position?: 'left' | 'right' }) {
    const [isVisible, setIsVisible] = useState(false)

    // 监听滚动显示/隐藏按钮
    useEffect(() => {
      const handleScroll = () => {
        // 滚动超过 400px 显示按钮
        setIsVisible(window.scrollY > 400)
      }

      window.addEventListener('scroll', handleScroll, { passive: true })
      return () => window.removeEventListener('scroll', handleScroll)
    }, [])

    // 点击回到顶部
    const scrollToTop = useCallback(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }, [])

    return (
      <Button
        size="icon"
        onClick={scrollToTop}
        className={cn(
          'fixed bottom-8 z-50 w-12 h-12 rounded-full',
          'shadow-lg transition-all duration-300 transform',
          position === 'left' ? 'left-8' : 'right-8',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none',
        )}
        aria-label="回到顶部"
      >
        <ArrowUp className="w-5 h-5" />
      </Button>
    )
  }

  const [appliedPrompt, setAppliedPrompt] = useState<string>('')
  const [appliedMaterials, setAppliedMaterials] = useState<string[]>([])

  // 处理提示词应用
  const handleApplyPrompt = useCallback(
    (data: { prompt: string, materials?: string[], mode: 'edit' | 'generate' }) => {
      setAppliedPrompt(data.prompt)
      setAppliedMaterials(data.materials || [])
      // 滚动到顶部
      window.scrollTo({ top: 0, behavior: 'smooth' })
      toast.success('Prompt applied!')
    },
    [],
  )

  // 从 URL query 读取 agentExternalPrompt 和 agentTaskId（由任务页通过 query 传参）
  const searchParams = useSearchParams()
  const router = useRouter()
  const [agentTaskId, setAgentTaskId] = useState<string>('')
  const params = useParams()

  // 解析 debug URL 参数，设置 debug 模式
  useEffect(() => {
    try {
      const debugParam = searchParams.get('debug')
      if (debugParam) {
        // 解析 debug=[file1.txt,file2.txt] 或 debug=file1.txt,file2.txt 格式
        const cleanedParam = debugParam.replace(/^\[|\]$/g, '')
        const files = cleanedParam
          .split(',')
          .map(f => f.trim())
          .filter(Boolean)

        if (files.length > 0) {
          setDebugFiles(files)

          // 清理 URL 上的 debug 参数
          const url = new URL(window.location.href)
          url.searchParams.delete('debug')
          router.replace(url.pathname + url.search)
        }
      }
    }
    catch (e) {
      console.warn('[AiSocialPageContent] Failed to parse debug param:', e)
    }
  }, [searchParams, router, setDebugFiles])

  useEffect(() => {
    try {
      const prompt = searchParams.get('agentExternalPrompt')
      const id = searchParams.get('agentTaskId')
      if (prompt) {
        setAppliedPrompt(prompt)
      }
      if (id) {
        setAgentTaskId(id)
      }
      // 清理 URL 上的 query，避免重复
      if (prompt || id) {
        // 桌面端首页为 #/，直接回到当前路径避免跳转到不存在的 /ai-social
        router.replace('/')
      }
    }
    catch (e) {
      // ignore
    }
  }, [searchParams, router, params.lng])

  // 清除外部提示词
  const handleClearExternalPrompt = useCallback(() => {
    setAppliedPrompt('')
    setAppliedMaterials([])
  }, [])

  return (
    <div
      className="bg-background"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 首页粒子汇聚背景（向真实线条 LOGO 聚拢，无随机漂移层） */}

      {!introMode && (
        /* 手工发布入口：AI 创作之外，可直接上传本地素材发布到各平台 */
        <div className="flex items-center justify-end gap-2 px-6 pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(`/${params.lng}/publish/video`)}
            className="gap-1.5 text-foreground/80 hover:text-foreground"
          >
            <Upload className="w-4 h-4" />
            手工发布
          </Button>
        </div>
      )}
      {/* 拖拽遮罩层 */}
      {isDragging && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4 p-8 rounded-2xl border-2 border-dashed border-primary bg-card">
            <Upload className="w-12 h-12 text-primary" />
            <p className="text-lg font-medium text-foreground">{t('dropToUpload')}</p>
          </div>
        </div>
      )}

      {!introMode && (
        <>
          {/* 首屏 Chat 区域（压缩高度，让创作输入与最近任务同屏形成完整工作区） */}
          <section className="flex items-center justify-center px-4 md:px-6 pt-5 md:pt-7 pb-4 md:pb-5">
            <HomeChat
              ref={homeChatRef}
              externalPrompt={appliedPrompt}
              externalMaterials={appliedMaterials}
              onClearExternalPrompt={handleClearExternalPrompt}
              agentTaskId={agentTaskId}
            />
          </section>

          {/* 任务预览区域 - 无数据时自动隐藏 */}
          <TaskPreview limit={4} className="px-4 md:px-6 py-4 md:py-5" />
        </>
      )}

      {/* 系统介绍 Hero（introMode，对齐官网留白 pt-16 pb-8 md:pt-24） */}
      {introMode && (
        <section className="relative flex min-h-screen items-center justify-center overflow-hidden border-b border-border/50 bg-gradient-to-b from-primary/5 to-transparent px-4">
          {/* 背景粒子汇聚：保留，只向静态 LOGO 聚拢，不绘制巨大点面标志 */}
          <LogoParticleField className="absolute inset-0" />
          <div className="relative z-10 flex max-w-3xl flex-col items-center text-center">
            {/* 静态品牌 LOGO */}
            <div data-logo-flow-target className="mb-4 shrink-0">
              <Image src={logo} alt="Bosom Friend" width={180} height={180} />
            </div>
            <h1 className="text-3xl font-bold text-foreground md:text-4xl">
              Bosom Friend AI 内容创作营销系统
            </h1>
            <p className="mt-4 text-base text-muted-foreground md:text-lg">
              AI 驱动的全自动内容创作、多平台发布与 7×24 客户接待一站式平台
            </p>
            <p className="mt-2 text-sm text-muted-foreground/80">
              面向零基础用户，一句需求即可开始创作
            </p>
            <div className="mt-8 flex items-center justify-center gap-3">
              <Button size="lg" className="cursor-pointer" onClick={() => router.push('/draft-box')}>
                开始创作
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* 提示词画廊区域（组件自身已带官网同款留白，避免重复叠加） */}
      <div className="flex min-h-screen items-center border-b border-border/50 bg-muted/30">
        <div className="w-full">
          <PromptGallery onApplyPrompt={handleApplyPrompt} />
        </div>
      </div>

      {/* AI Agent 功能亮点（独立展示） */}
      <div className="flex min-h-screen items-center border-b border-border/50">
        <div className="w-full">
          <AgentFeatures />
        </div>
      </div>

      {/* 一图解读 Bosom Friend 生态 */}
      <div className="flex min-h-screen items-center bg-muted/30">
        <div className="w-full">
          <EcosystemDiagram />
        </div>
      </div>

      {/* 回到顶部按钮 - 右侧 */}
      <BackToTop position="right" />
    </div>
  )
}
