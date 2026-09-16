/**
 * 路由/导航数据配置
 * Bosom Friend系统导航：内容创作 / AI互动 / 任务记录 / 账号管理 / 发布日历 / 数据中心 / 全局监控 / 知识库 / 设置
 */

import {
  Activity,
  BarChart3,
  BookOpen,
  CalendarDays,
  Clapperboard,
  History,
  Home,
  MessagesSquare,
  UserRound,
  Users,
} from 'lucide-react'
import { useChannelManagerStore } from '@web/components/ChannelManager'

export interface IRouterDataItem {
  name: string
  translationKey: string
  path?: string
  icon?: React.ReactNode
  children?: IRouterDataItem[]
  /** 存在时作为按钮入口（不跳路由），用于弹窗。 */
  onClick?: () => void
}

export const routerData: IRouterDataItem[] = [
  {
    name: '内容创作',
    translationKey: 'header.draftBox',
    path: '/draft-box',
    icon: <Home size={20} />,
  },
  {
    // 长视频产出通用工作流：数字人口播 / 场景呈现都从这里进
    name: '长视频创作',
    translationKey: 'header.longVideo',
    path: '/long-video',
    icon: <Clapperboard size={20} />,
  },
  {
    name: '我的数字人',
    translationKey: 'header.digitalHumans',
    path: '/digital-humans',
    icon: <UserRound size={20} />,
  },
  {
    name: 'AI互动',
    translationKey: 'xhsData',
    path: '/ai-interaction',
    icon: <MessagesSquare size={20} />,
  },
  {
    name: '任务记录',
    translationKey: 'myTasks',
    path: '/tasks-history',
    icon: <History size={20} />,
  },
  {
    name: '发布日历',
    translationKey: 'calendar',
    path: '/calendar',
    icon: <CalendarDays size={20} />,
  },
  {
    name: '数据中心',
    translationKey: 'dataCenter',
    path: '/data-statistics',
    icon: <BarChart3 size={20} />,
  },
  {
    name: '全局监控',
    translationKey: 'monitor',
    path: '/monitor',
    icon: <Activity size={20} />,
  },
  {
    name: '知识库',
    translationKey: 'knowledge',
    path: '/knowledge',
    icon: <BookOpen size={20} />,
  },
]

export const visibleRouterData = routerData
