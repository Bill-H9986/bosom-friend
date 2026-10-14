/*
 * @Author: nevin
 * @Date: 2025-01-17 19:25:29
 * @LastEditTime: 2025-03-23 15:00:16
 * @LastEditors: nevin
 * @Description: 主应用
 */

import { RouterProvider } from 'react-router-dom';
import router from '@/router/index';
import { ConfigProvider, notification } from 'antd';
import Inform from './components/Inform';
import { useEffect } from 'react';
import { useCommontStore } from './store/commont';
import { useUserStore as useWebUserStore } from '@web/store/user';

const App = () => {
  const [api, contextHolder] = notification.useNotification({
    top: 74,
  });

  useEffect(() => {
    useCommontStore.getState().setNotification(api);
    // 初始化 Web 端用户会话（内测免登录：主进程注入的内置账号 token）
    const autoLoginToken = typeof window !== 'undefined'
      ? (window as any).__ZHIYIN_AUTH_TOKEN__ || undefined
      : undefined
    useWebUserStore.getState().appInit(autoLoginToken);
  }, []);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#a78bfa',
        },
      }}
    >
      {contextHolder}
      <Inform onChooseItem={() => {}} />
      <RouterProvider router={router} />
    </ConfigProvider>
  );
};

export default App;
