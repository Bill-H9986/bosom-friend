import { useUserStore } from '@/store/user';
import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { sleep } from '../../commont/utils';
import { useBellMessageStroe } from '../store/bellMessageStroe';
import { useNetStatusStore } from '../store/netStatusStore';
import WebAppLayout from '@web/desktop-pages/WebAppLayout';

export const LayoutBody = () => {
  const userStore = useUserStore();

  // 查询用户信息
  const queryUserInfo = async () => {
    let count = 0;
    while (true) {
      const res = await userStore.getUserInfo().catch(() => false);
      if (res || count >= 10) break;
      await sleep(1000);
      count++;
    }
  };

  useEffect(() => {
    useBellMessageStroe.getState().videoPublishProgressInit();
    if (userStore.token) {
      queryUserInfo();
    } else {
      userStore.logout();
    }
  }, []);

  // 添加键盘事件监听
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.code === 'KeyI') {
        event.preventDefault();
        window.ipcRenderer.invoke('OPEN_DEV_TOOLS', 'right');
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // 这里曾初始化 electron 侧的账号 store（IPC + electron DB），它与 Web 侧 store（HTTP API）
  // 是两套数据源，而且 init() 会起一个 10~30 分钟一轮的账号有效性轮询循环。
  // 全仓确认：那份 store 的数据只剩未挂路由的 views/publish 老发布页在读，
  // 活跃页面（内容创作 / 账号管理 / 发布日历…）全部走 Web 侧 store，因此这里不再初始化它。

  // 全局网络状态（非侵入式横幅）
  const netOffline = useNetStatusStore((state) => state.offline);
  const netMessage = useNetStatusStore((state) => state.message);
  const clearNetStatus = useNetStatusStore((state) => state.clear);

  if (!userStore.token) {
    return <Navigate to="/login" replace />;
  }

  return (
    <WebAppLayout />
  );
};
