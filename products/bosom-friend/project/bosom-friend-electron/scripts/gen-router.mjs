import fs from 'node:fs'

const content = `/*
 * 知音AI内容营销系统 - 路由表
 * 平台定位：AISEO / AIGEO 内容创作营销一站式服务，面向零基础用户
 * 核心链路：AI创作 -> 一键发布 -> 草稿箱 -> 任务记录 -> 素材库 -> 账号矩阵 -> 自动接待 -> 数据中心
 */
import {
  createHashRouter,
  IndexRouteObject,
  Navigate,
  NonIndexRouteObject,
} from 'react-router-dom';
import { AntdIconProps } from '@ant-design/icons/lib/components/AntdIcon';
import {
  CopyOutlined,
  UsergroupAddOutlined,
  AuditOutlined,
  OpenAIOutlined,
  EditOutlined,
  HistoryOutlined,
  PictureOutlined,
  RobotOutlined,
} from '@ant-design/icons';

// 组件
import { LayoutBody } from '@/layout/LayoutBody';

// 页面组件
import Login from '@/views/login';
import Publish from '@/views/publish/page';
import VideoPage from '@/views/publish/children/videoPage/page';
import ImagePage from '@/views/publish/children/imagePage/page';
import PubRecord from '@/views/publish/children/pubRecord/page';
import Statistics from '@/views/statistics/statistics';
import ErrorBoundary from '../components/ErrorBoundary/ErrorBoundary';
import UserProfile from '@/views/user/mine/UserProfile';
import AiSocialPage from '@web/desktop-pages/AiSocialPage';
import DraftBoxPage from '@web/desktop-pages/DraftBoxPage';
import TasksHistoryPage from '@web/desktop-pages/TasksHistoryPage';
import AgentAssetsPage from '@web/desktop-pages/AgentAssetsPage';
import AccountPage from '@web/desktop-pages/AccountPage';
import ChatDetailPage from '@web/desktop-pages/ChatDetailPage';
import SharedChatPage from '@web/desktop-pages/SharedChatPage';
import Reception from '@/views/reception';

interface IRouterMeta {
  name?: string;
  icon?: React.ForwardRefExoticComponent<
    Omit<AntdIconProps, 'ref'> & React.RefAttributes<HTMLSpanElement>
  >;
}

interface ICustomRoute {
  meta?: IRouterMeta;
}

interface ICustomIndexRouteObject extends IndexRouteObject {}
interface ICustomNonIndexRouteObject extends NonIndexRouteObject {
  children?: CustomRouteObject[];
}
type CustomRouteObject =
  | (ICustomIndexRouteObject & ICustomRoute)
  | (ICustomNonIndexRouteObject & ICustomRoute);

/**
 * 路由表
 * 只有 router[0] 才会被渲染到导航，请不要改动一级数据的顺序。
 * router[0].children 下的路由如果存在 meta 会渲染到 nav
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
      { path: '/publish', element: <Navigate to="/publish/video" /> },

      // 核心业务链路 ---------
      {
        path: '/',
        element: <AiSocialPage />,
        meta: { name: 'AI创作', icon: OpenAIOutlined },
      },
      {
        path: '/publish',
        element: <Publish />,
        meta: { name: '一键发布', icon: CopyOutlined },
        children: [
          {
            path: 'video',
            element: <VideoPage />,
          },
          {
            path: 'image',
            element: <ImagePage />,
          },
          { path: 'pubRecord', element: <PubRecord /> },
        ],
      },
      {
        path: '/draft-box',
        element: <DraftBoxPage />,
        meta: { name: '草稿箱', icon: EditOutlined },
      },
      {
        path: '/tasks-history',
        element: <TasksHistoryPage />,
        meta: { name: '任务记录', icon: HistoryOutlined },
      },
      {
        path: '/agent-assets',
        element: <AgentAssetsPage />,
        meta: { name: '素材库', icon: PictureOutlined },
      },
      {
        path: '/accounts',
        element: <AccountPage />,
        meta: { name: '账号矩阵', icon: UsergroupAddOutlined },
      },
      {
        path: '/reception',
        element: <Reception />,
        meta: { name: '自动接待', icon: RobotOutlined },
      },
      {
        path: '/statistics',
        element: <Statistics />,
        meta: { name: '数据中心', icon: AuditOutlined },
      },

      // 隐藏路由（无导航）---------
      { path: '/ai-social', element: <AiSocialPage /> },
      { path: '/chat', element: <SharedChatPage /> },
      { path: '/chat/:taskId', element: <ChatDetailPage /> },
      {
        path: '/user',
        children: [
          { path: 'mine', element: <UserProfile /> },
        ],
      },
    ],
  },
  { path: '/login', element: <Login /> },
];

export default createHashRouter(router);
`

const p = 'C:/Users/Jay/Desktop/AiToEarn-main/project/aitoearn-electron/src/router/index.tsx'
fs.writeFileSync(p, content, 'utf8')
console.log('router rewritten')
