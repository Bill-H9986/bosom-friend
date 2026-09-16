/*
 * Bosom FriendAI内容创作营销系统 - 路由表
 * 平台定位：AISEO / AIGEO 内容创作营销一站式服务，面向零基础用户
 * 核心链路：AI创作 -> 一键发布 -> 草稿箱 -> 任务记录 -> 素材库 -> 账号矩阵 -> 自动接待 -> 数据中心
 *
 * 说明（stage-c 清理）：
 * 1. 路由 meta 为死代码（LayoutBody 不渲染任何 meta/nav，导航由 Web 端 WebAppLayout 驱动），已全部移除。
 * 2. /reception 独立路由已删除：其视图 Reception 已被 @web/app/[lng]/accounts/accountCore.tsx 内嵌复用。
 * 3. /hot-content 系列（半死）路由已删除：Electron 端无任何代码跳转，Web 组件内部跳转带 /[lng] 前缀不匹配。
 */
import {
  createHashRouter,
  IndexRouteObject,
  Navigate,
  NonIndexRouteObject,
} from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { Spin } from 'antd';

// 组件
import { LayoutBody } from '@/layout/LayoutBody';

// 页面组件（懒加载：按路由拆分构建产物，减小启动包体积）
import ErrorBoundary from '../components/ErrorBoundary/ErrorBoundary';
const SystemIntroPage = lazy(() => import('@web/desktop-pages/SystemIntroPage'));
const SettingsPage = lazy(() => import('@web/desktop-pages/SettingsPage'));
const DraftBoxPage = lazy(() => import('@web/desktop-pages/DraftBoxPage'));
const AgentAssetsPage = lazy(() => import('@web/desktop-pages/AgentAssetsPage'));
const AccountPage = lazy(() => import('@web/desktop-pages/AccountPage'));
const ChatDetailPage = lazy(() => import('@web/desktop-pages/ChatDetailPage'));
const SharedChatPage = lazy(() => import('@web/desktop-pages/SharedChatPage'));
const AiInteractionPage = lazy(() => import('@web/desktop-pages/AiInteractionPage'));
const TasksHistoryPage = lazy(() => import('@web/desktop-pages/TasksHistoryPage'));
const KnowledgePage = lazy(() => import('@web/desktop-pages/KnowledgePage'));
const MonitorPage = lazy(() => import('@web/desktop-pages/MonitorPage'));
const DataStatsPage = lazy(() => import('@web/desktop-pages/DataStatsPage'));
const CalendarPage = lazy(() => import('@web/desktop-pages/CalendarPage'));
const LongVideoPage = lazy(() => import('@web/desktop-pages/LongVideoPage'));
const DigitalHumansPage = lazy(() => import('@web/desktop-pages/DigitalHumansPage'));

interface ICustomIndexRouteObject extends IndexRouteObject {}
interface ICustomNonIndexRouteObject extends NonIndexRouteObject {
  children?: CustomRouteObject[];
}
type CustomRouteObject = ICustomIndexRouteObject | ICustomNonIndexRouteObject;

/** 懒加载页面统一加载态 */
const PageFallback = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 240,
    }}
  >
    <Spin size="large" />
  </div>
);

const lazyElement = (node: React.ReactNode) => (
  <Suspense fallback={<PageFallback />}>{node}</Suspense>
);

/**
 * 路由表
 * 只有 router[0] 才会被渲染到导航，请不要改动一级数据的顺序。
 */
export const router: CustomRouteObject[] = [
  {
    element: (
      <ErrorBoundary>
        <LayoutBody />
      </ErrorBoundary>
    ),
    children: [
      // 重定向 ---------
      { path: '/statistics', element: <Navigate to="/data-statistics" replace /> },
      { path: '/monitor', element: lazyElement(<MonitorPage />) },
      { path: '/data-statistics', element: lazyElement(<DataStatsPage />) },
      { path: '/calendar', element: lazyElement(<CalendarPage />) },

      // 核心业务链路 ---------
      {
        path: '/',
        element: lazyElement(<SystemIntroPage />),
      },
      {
        path: '/draft-box',
        element: lazyElement(<DraftBoxPage />),
      },
      {
        // 长视频产出：数字人口播 / 场景呈现共用同一条通用工作流
        path: '/long-video',
        element: lazyElement(<LongVideoPage />),
      },
      {
        path: '/digital-humans',
        element: lazyElement(<DigitalHumansPage />),
      },
      {
        path: '/tasks-history',
        // 任务记录已并入「内容创作」页面（内容创作 → 任务记录标签）
        element: lazyElement(<TasksHistoryPage />),
      },
      {
        path: '/agent-assets',
        element: lazyElement(<AgentAssetsPage />),
        // 已并入「内容创作」页（素材标签），不再单独显示导航
      },
      {
        path: '/accounts',
        element: lazyElement(<AccountPage />),
      },
      {
        path: '/account',
        element: <Navigate to="/accounts" replace />,
        // 账号授权/详情已统一并入「账号管理」页，此旧路由直接重定向
      },
      {
        path: '/ai-interaction',
        element: lazyElement(<AiInteractionPage />),
      },
      {
        path: '/knowledge',
        element: lazyElement(<KnowledgePage />),
      },


      {
        path: '/settings',
        element: lazyElement(<SettingsPage />),
      },

      // 隐藏路由（无导航）---------
      { path: '/chat', element: lazyElement(<SharedChatPage />) },
      { path: '/chat/:taskId', element: lazyElement(<ChatDetailPage />) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
  // 内测免登录模式：不再提供独立登录页（登录 UI 统一为新版 LoginDialog，
  // 免登录模式下不触发），旧 #/login 路由直接回首页，杜绝双套登录逻辑
  { path: '/login', element: <Navigate to="/" replace /> },
];

export default createHashRouter(router);
