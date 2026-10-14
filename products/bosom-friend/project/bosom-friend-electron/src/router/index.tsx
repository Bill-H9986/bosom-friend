/*
 * Bosom FriendAI内容创作营销系统 - 路由表
 * 平台定位：AISEO / AIGEO 内容创作营销一站式服务，面向零基础用户
 * 核心链路：AI创作 -> 一键发布 -> 草稿箱 -> 任务记录 -> 素材库 -> 账号矩阵 -> 自动接待 -> 数据中心
 *
 * 说明（stage-c 清理）：
 * 1. 路由 meta 为死代码（LayoutBody 不渲染任何 meta/nav，导航由 Web 端 WebAppLayout 驱动），已全部移除。
 * 2. /reception 独立路由已删除：其视图 Reception 已被 @web/app/[lng]/accounts/accountCore.tsx 内嵌复用。
 * 3. /hot-content 系列（半死）路由已删除：Electron 端无任何代码跳转，Web 组件内部跳转带 /[lng] 前缀不匹配。
 *    注意（2026-10-11 复核，纠正 D5 的猜测）：路由删对了，但 `app/[lng]/hot-content/` 那一组**组件**
 *    仍被「AI互动」页实际引用（HotContentClient / getHotContentFeed），不是可删残留。
 *
 * 4. 2026-10-11（S4 导航收敛）：路由表**不改**——旧 7 条（#/draft-box、#/tasks-history、#/calendar、
 *    #/data-statistics、#/monitor、#/ai-interaction、#/knowledge）全部保留原样，
 *    导航收敛只发生在 Web 侧的 `routerData`（一级 3 项，旧 7 项降为看板二级），
 *    这样任何旧书签仍能直达，S 级监考里按 hash 直达的脚本也不受影响。
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
// 管家团队页（ADR-005 呈现层改造方案 v1.0 的 N1 / S3）：一屏回答"谁在干什么"。
const TeamPage = lazy(() => import('@web/desktop-pages/TeamPage'));
// 看板聚合页（BoardsPage）2026-10-12 停用，见下方路由处的说明。

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
      // 首屏：2026-10-12 恢复为 SystemIntroPage —— 它是 09-30 起一直在用的完整首页
      // （官网介绍 + 创作输入框 + 最近任务）。ADR-005 的「对话主入口」把同一个页面
      // 拆成「/ 只留对话区、官网内容挪去 /about」两处，用户反馈「排版被打乱、功能重复」；
      // 而 ConversationHomePage 只是同一个组件换个开关，本身就是重复入口。
      {
        path: '/',
        element: lazyElement(<SystemIntroPage />),
      },
      // 旧书签 #/about 仍可达：它指向的正是首屏这一页。
      { path: '/about', element: <Navigate to="/" replace /> },
      {
        path: '/draft-box',
        element: lazyElement(<DraftBoxPage />),
      },
      // 长视频产出与数字人形象库 2026-09-30 起并入「内容创作」页的两个标签，
      // 不再是独立板块；旧链接与书签一律重定向过去（与 /account、/statistics 同一处理）。
      { path: '/long-video', element: <Navigate to="/draft-box" replace /> },
      { path: '/digital-humans', element: <Navigate to="/draft-box" replace /> },
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
      // 管家团队：保留。它是 ADR-005 的独有视角（按管家看谁在办、卡在哪、待拍板），
      // 可见入口在侧边栏底部功能区，与「添加频道 / 设置」同组，不再进一级导航。
      {
        path: '/team',
        element: lazyElement(<TeamPage />),
      },
      // 看板聚合页 2026-10-12 停用：它的 8 个入口与左侧一级导航逐条重复
      // （数据中心 / 全局监控 / 内容创作 / 发布日历 / 素材库 / 任务记录 / AI互动 / 知识库）。
      // 旧书签 #/boards 跳到数据中心，不再保留第二个入口。
      { path: '/boards', element: <Navigate to="/data-statistics" replace /> },


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
