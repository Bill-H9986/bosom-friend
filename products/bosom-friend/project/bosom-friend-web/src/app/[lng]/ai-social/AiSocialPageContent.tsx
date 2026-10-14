/**
 * AI 社媒内容组件 - AI social media Page Content
 * 客户端组件，包含所有交互逻辑
 */
'use client'

import type { IHomeChatRef } from './components/HomeChat'
import { ArrowUp, Sparkles, Upload } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from '@web/next-shims/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@web/components/ui/button'
import { useAccountStore } from '@web/store/account'
import { useAgentStore } from '@web/store/agent'
import { openPublishDialog } from '@web/store/publishDialogHost'
import { cn } from '@web/utils/className'
import { toast } from '@web/utils/ui/toast'
import { useTransClient } from '../../i18n/client'
import AgentFeatures from './components/AgentFeatures'
import EcosystemDiagram from './components/EcosystemDiagram'
import { HomeChat } from './components/HomeChat'
import { LogoParticleField } from '@web/components/effects/LogoParticleField'
import { OneSentenceEquivalents } from '../tasks-history/components/OneSentenceEquivalents'
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
  // 本组件同时服务首屏（/）与介绍页（/about）：清 query 只能回到当前页，
  // 否则在 /about 上带了 agentExternalPrompt 时会把人甩回首屏。
  const pathname = usePathname()
  const [agentTaskId, setAgentTaskId] = useState<string>('')

  // 手工发布：打开发布弹窗（全应用唯一发布入口，宿主挂在布局壳里）。
  //
  // 这里原先跳转到一个带语言前缀的 /publish/video 路径：桌面壳是 hash 路由、路由表没有 [lng] 段，
  // useParams() 拿不到 lng，于是拼出 /undefined/publish/video，落到路由兜底被送回首页——
  // 用户看到的就是「点了没反应」。而 /publish/video 本身也已是退休入口：
  // Web 源码包从来没有 publish 页面，桌面路由表里也没有这条。
  const accountList = useAccountStore(state => state.accountList)
  const handleManualPublish = useCallback(() => {
    openPublishDialog({ accounts: accountList })
  }, [accountList])

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
        router.replace(pathname === '/about' ? '/about' : '/')
      }
    }
    catch (e) {
      // ignore
    }
  }, [searchParams, router, pathname])

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
        <div className="flex items-center justify-end gap-2 px-8 pt-8">
          <Button
            variant="outline"
            size="sm"
            onClick={handleManualPublish}
            className="gap-2 text-foreground/80 hover:text-foreground"
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
          {/* 首屏 Chat 区域：一屏只讲一件事——让输入框占据视觉中心（规范第 5 节） */}
          <section className="flex items-center justify-center px-8 pt-12 pb-8">
            <HomeChat
              ref={homeChatRef}
              externalPrompt={appliedPrompt}
              externalMaterials={appliedMaterials}
              onClearExternalPrompt={handleClearExternalPrompt}
              agentTaskId={agentTaskId}
            />
          </section>

          {/* 任务预览区域 - 无数据时自动隐藏 */}
          <TaskPreview limit={4} className="px-8 py-8" />
        </>
      )}

      {/* 系统介绍 Hero（introMode，对齐官网留白 pt-16 pb-8 md:pt-24） */}
      {introMode && (
        <section className="relative flex min-h-screen items-center justify-center overflow-hidden border-b border-border/50 bg-gradient-to-b from-primary/5 to-transparent px-8">
          {/* 背景粒子汇聚：保留，只向静态 LOGO 聚拢，不绘制巨大点面标志 */}
          <LogoParticleField className="absolute inset-0" />
          <div className="relative z-10 flex max-w-3xl flex-col items-center text-center">
            {/* 静态品牌 LOGO */}
            <div data-logo-flow-target className="mb-4 shrink-0">
              <Image src={logo} alt="Bosom Friend" width={180} height={180} />
            </div>
            {/* 2026-10-13 观感优化（第二轮）：产品负责人指出"不占满、没设计感"。
                做法：① 恢复占满屏 ② 标题放大 + 渐隐提高层次 ③ 加一个**大输入框**当视觉锚点
                （点它直接聚焦右侧 AI 助手，把"该去哪儿说话"变成看得见的动作，而不是一行小字提示）
                ④ 下面给三条快捷示例 chips。 */}
            <h1 className="bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-5xl font-bold tracking-tight text-transparent md:text-6xl">
              Bosom Friend
            </h1>
            <p className="mt-4 text-lg text-muted-foreground md:text-xl">
              说一句话，从创作到发布的事它自己办完
            </p>
            <button
              type="button"
              onClick={() => {
                const box = document.querySelector('textarea, [contenteditable="true"]') as HTMLElement | null
                box?.focus()
              }}
              className="group mt-10 flex w-full max-w-xl cursor-pointer items-center gap-3 rounded-2xl border border-border/70 bg-background/80 px-5 py-4 text-left shadow-lg shadow-brand-cyan/5 backdrop-blur transition-all hover:border-brand-cyan/40 hover:shadow-xl hover:shadow-brand-cyan/10"
            >
              <Sparkles className="h-4 w-4 shrink-0 text-brand-cyan" />
              <span className="flex-1 text-sm text-muted-foreground">想让管家做什么？在这里说一句话…</span>
              <span className="shrink-0 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity group-hover:opacity-90">
                去说
              </span>
            </button>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {['写一条小红书图文', '最近数据怎么样', '有评论要回吗'].map((s) => (
                <span key={s} className="rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
                  {s}
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 官网式介绍内容（提示词画廊 / 功能亮点 / 生态图）只在介绍页（/about，introMode）渲染：
          首屏是对话主入口，ADR-005 要求它不给板块网格与营销内容——把营销内容留在首屏下方
          就是「打开 APP 还是官网」的观感。 */}
      {introMode && (
        <>
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
        </>
      )}

      {/* 一句话等价物：官网首屏（introMode）与对话首页都在末尾给一次，纯展示、无执行入口 */}
      <OneSentenceEquivalents page="home" />

      {/* 回到顶部按钮 - 右侧 */}
      <BackToTop position="right" />
    </div>
  )
}
