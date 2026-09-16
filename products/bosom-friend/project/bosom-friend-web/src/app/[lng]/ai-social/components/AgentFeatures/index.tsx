/**
 * AgentFeatures - AI Agent 功能亮点网格展示（用于首页）
 * Zhiyin 官网同款：静态卡片网格，桌面端 4 列，信息密度高
 */
'use client'

import type { FC } from 'react'
import {
  Activity,
  BarChart3,
  Calendar,
  Download,
  FileText,
  Frame,
  Hash,
  Image as ImageIcon,
  Languages,
  Layers,
  Lightbulb,
  ListTodo,
  MessageSquare,
  MonitorSmartphone,
  PanelTop,
  ScanEye,
  Scissors,
  Search,
  Send,
  Timer,
  Users,
  Video,
  Workflow,
} from 'lucide-react'
import { useTransClient } from '@web/app/i18n/client'
import { useRouter } from '@web/next-shims/navigation'
import { cn } from '@web/utils/className'

import './style.css'

interface AgentFeaturesProps {
  className?: string
}

// 图标映射 - 每个功能使用不同的图标
const iconMap = {
  inspiration: Lightbulb, // 创意灵感 - 灯泡
  oneClickScript: FileText, // 一键生成脚本 - 文档
  multiTemplates: Layers, // 多风格模板 - 图层
  imageGenerate: ImageIcon, // 图片生成 - 图片
  videoGenerate: Video, // 视频生成 - 视频
  highlight: Scissors, // 高光剪辑 - 剪刀
  storyboard: PanelTop, // 分镜设计 - 面板
  coverSuggestion: Frame, // 封面建议 - 相框
  download: Download, // 素材下载 - 下载
  videoTranslation: Languages, // 视频翻译 - 语言
  platformAdapt: MonitorSmartphone, // 平台适配 - 多设备
  topicTag: Hash, // 话题标签 - 标签
  seo: Search, // SEO优化 - 搜索
  schedule: Calendar, // 定时发布 - 日历
  multiPlatform: Send, // 多平台分发 - 发送
  smartTime: Timer, // 智能发布时间 - 计时器
  sse: Activity, // 流式任务 - 活动/脉冲
  taskManagement: ListTodo, // 任务管理 - 待办列表
  workflow: Workflow, // 可扩展工作流 - 工作流
  videoUnderstanding: ScanEye, // 视频理解 - 扫描眼睛
  report: BarChart3, // 运营报告 - 柱状图
  commentAssistant: MessageSquare, // 评论助手 - 消息
  audienceInsight: Users, // 用户画像 - 用户组
} as const

// 所有功能项
const allFeatures = [
  'inspiration',
  'oneClickScript',
  'multiTemplates',
  'imageGenerate',
  'videoGenerate',
  'highlight',
  'storyboard',
  'coverSuggestion',
  'download',
  'videoTranslation',
  'platformAdapt',
  'topicTag',
  'seo',
  'schedule',
  'multiPlatform',
  'smartTime',
  'sse',
  'taskManagement',
  'workflow',
  'videoUnderstanding',
  'report',
  'commentAssistant',
  'audienceInsight',
]

/** 功能卡片 → 功能页路由（打通 Agent 能力入口） */
const FEATURE_ROUTE: Record<string, string> = {
  report: '/draft-box',
  commentAssistant: '/',
  audienceInsight: '/draft-box',
}

/**
 * 功能卡片组件 - icon 和 title 同行布局
 */
interface FeatureCardProps {
  itemKey: string
  t: (key: string) => string
  onClick: () => void
}

const FeatureCard: FC<FeatureCardProps> = ({ itemKey, t, onClick }) => {
  const Icon = iconMap[itemKey as keyof typeof iconMap]
  const title = t(`agentFeatures.items.${itemKey}.title`)
  const desc = t(`agentFeatures.items.${itemKey}.desc`)

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-full w-full flex-col rounded-2xl border border-border bg-card p-4 text-left transition-all duration-200 ease-apple-out hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:scale-[0.99] cursor-pointer"
    >
      {/* icon + title 同行 */}
      <div className="flex items-center gap-3 mb-2">
        {/* 浅紫渐变图标容器（官网同款） */}
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#8b7cf6]/10 to-[#a78bfa]/15"
        >
          <Icon className="h-[18px] w-[18px] text-[#a78bfa]" />
        </div>
        <h4 className="text-sm font-medium text-foreground line-clamp-1">{title}</h4>
      </div>

      {/* 描述 */}
      <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2 text-left">{desc}</p>
    </button>
  )
}

/**
 * AgentFeatures 主组件
 */
const AgentFeatures: FC<AgentFeaturesProps> = ({ className }) => {
  const { t } = useTransClient('promptGallery')
  const router = useRouter()

  const handleFeatureClick = (itemKey: string) => {
    router.push(FEATURE_ROUTE[itemKey] || '/draft-box')
  }

  return (
    <section className={cn('py-10 px-4 md:px-6 lg:px-8', className)}>
      <div className="w-full max-w-6xl mx-auto">
        {/* 标题区域 */}
        <div className="mb-10 text-center">
          <h2 className="mb-3 text-3xl font-bold text-foreground">
            {t('agentFeatures.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('agentFeatures.subtitle')}
          </p>
        </div>

        {/* 静态网格：桌面 4 列 / 平板 3 列 / 移动 2 列 */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {allFeatures.map(itemKey => (
            <FeatureCard
              key={itemKey}
              itemKey={itemKey}
              t={t}
              onClick={() => handleFeatureClick(itemKey)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

export default AgentFeatures
