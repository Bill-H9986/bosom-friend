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
    // D4（呈现层改造方案 5.3 节）：通知中心的**孤儿**现况——
    // 这里的初始化仍在跑（它每 10 秒轮询一次发布进度写进通知表），但消费方只剩
    // 未挂路由的旧发布页（src/views/publish/.../VideoPubSetModal.tsx），
    // 主界面上没有任何可见入口读它 → 用户看不到这些通知。
    // 处置（接进看板 / 删）属产品负责人未决项，按"未拍板前一律降级不删"保留原逻辑，
    // 只把事实写在这里，避免下一个人以为"界面没看到=没实现"。
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
