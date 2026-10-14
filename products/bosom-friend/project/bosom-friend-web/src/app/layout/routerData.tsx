/**
 * 路由/导航数据配置
 *
 * Bosom Friend 系统导航（2026-10-12 恢复）：
 * 内容创作 / 任务记录 / 发布日历 / 数据中心 / 全局监控 / AI互动 / 知识库
 * —— 与 09-30 起一直在用的原样一致（顺序、图标、翻译键都照旧）。
 *
 * 为什么恢复：ADR-005 呈现层改造曾把这里收敛成「对话 / 管家团队 / 看板」三项一级，
 * 旧 7 项降级为「看板」下的二级。用户反馈「很多功能是重复多余的、以前的都有、
 * 整个项目的功能页排版全被打乱」。核实结果：看板页那 8 个入口与这 7 项**逐条重复**
 * （唯一多出来的是素材库，它本就不是一级导航项），已停用并跳到数据中心；
 * 管家团队不进一级导航，改在侧边栏底部（与「添加频道 / 设置」同组）。
 *
 * 改这里的硬约束：任何一条旧路由都不能消失（旧书签必须仍可直达）。路由表在
 * electron 侧 `src/router/index.tsx`，那里保留全部旧路由与重定向。
 */

import type { ReactNode } from 'react'
import {
  Activity,
  BarChart3,
  BookOpen,
  CalendarDays,
  History,
  Home,
  MessagesSquare,
} from 'lucide-react'

export interface IRouterDataItem {
  name: string
  translationKey: string
  path?: string
  icon?: ReactNode
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
  // 「长视频创作」「我的数字人」2026-09-30 起**并入本页**：不再是独立页面、不再是独立路由，
  // 而是「内容创作」页里的「长视频」「数字人」两个标签（见 app/[lng]/draft-box/DraftBoxCore.tsx）。
  // 分段编排引擎（写稿→分镜→逐镜出片→拼接）仍在——内容创作的 30 秒 / 1 分钟档走的就是它
  // （>12 秒官方单次不支持，必须分段）。旧 URL #/long-video、#/digital-humans 一律重定向到本页。
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
    // AI 互动紧挨着知识库：两者是一件事的两端——知识库喂给互动的话术，互动回来又问知识库。
    name: 'AI互动',
    translationKey: 'xhsData',
    path: '/ai-interaction',
    icon: <MessagesSquare size={20} />,
  },
  {
    name: '知识库',
    translationKey: 'knowledge',
    path: '/knowledge',
    icon: <BookOpen size={20} />,
  },
]

export const visibleRouterData = routerData
