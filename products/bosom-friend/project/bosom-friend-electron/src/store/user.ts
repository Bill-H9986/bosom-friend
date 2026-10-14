import { createPersistStore } from '@/utils/createPersistStore';
import { IRefreshToken, IUserInfo } from '@/api/types/user-t';
import { userApi } from '@/api/user';
import { StoreKey } from '@/utils/StroeEnum';
import router from '@/router/index';
import { usePubStroe } from './pubStroe';

export interface IUserStore {
  userInfo?: IUserInfo;
  token: string;
  overdueTime: number;
  refreshTokenLoading: boolean;
}

// 开发者模式：自动模拟登录，跳过登录页（仅本地开发生效，打包后走正常登录）
const isDev = import.meta.env.DEV

// 打包版由主进程注入持久化登录 token（preload 暴露 __ZHIYIN_AUTH_TOKEN__），
// 渲染端用自己的 store 也读取同一份注入，避免 LayoutBody 判定未登录跳登录页。
const injectedToken =
  typeof window !== 'undefined' ? (window as any).__ZHIYIN_AUTH_TOKEN__ : undefined

const DEV_MOCK_USER: IUserInfo = {
  _id: 'dev-user-001',
  id: 'dev-user-001',
  name: 'Bosom Friend客户端',
  phone: '13800000000',
}

const state: IUserStore = {
  userInfo: isDev ? DEV_MOCK_USER : undefined,
  token: isDev ? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhNzkzZGE4MWYwYmZhYjhhZDVkMDY0OCIsIm1haWwiOiJhZG1pbkBhaXRvZWFybi5sb2NhbCIsIm5hbWUiOiJBZG1pbiIsImlhdCI6MTc4NjMzMDUzNiwiZXhwIjo0OTQyMDkwNTM2fQ.QUQqQ7xI935ZWF6GE6RBaNJoKUVz1S1gW1WPZCLbc1s' : injectedToken || '',
  overdueTime: isDev
    ? Date.now() + 100 * 365 * 24 * 3600 * 1000
    : injectedToken
      ? Date.now() + 100 * 365 * 24 * 3600 * 1000
      : 0,
  // 是否开始刷新token，防止多次调用
  refreshTokenLoading: false,
};

export const useUserStore = createPersistStore(
  {
    ...state,
  },
  (set, _get) => {
    return {
      // 清除登录状态（DEV 下也不能回填 mock token，否则退出登录无效）
      clearLoginStatus() {
        set({
          token: '',
          userInfo: undefined,
          overdueTime: 0,
        });
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('zhiyin-user-logged-out', '1');
        }
        usePubStroe.getState().clear();
        // 这里曾清 electron 侧账号 store（IPC + electron DB）。那份 store 已不再被任何活跃页面读取，
        // 也不再被初始化（见 layout/LayoutBody.tsx），留着只会把整套老发布栈拖进产物。
      },

      // 退出登录
      logout() {
        console.log('登出！');
        this.clearLoginStatus();
        if (window.location.href !== 'login') {
          router.navigate('/login');
        }
      },

      // 获取用户信息
      async getUserInfo(userInfo?: IUserInfo) {
        if (userInfo) {
          set({ userInfo: userInfo });
          return;
        }
        const res = await userApi.getUserInfo();
        if (!res) return;
        set({ userInfo: res });
        return res;
      },

      // 设置Token
      setToken({ token, exp }: IRefreshToken) {
        set({ token: token, overdueTime: exp });
      },

      // 2026-10-12 改：原实现在「距过期不足 4 小时」时调用 userApi.refreshToken()，而
      // `/user/token/refresh` 是旧 SaaS 契约——**后端没有这条路由**（八路审计里 A 类 16 条真问题之一）。
      // 触发时的后果是双重的：拦截器弹「no such endpoint」错误，且 refreshTokenLoading 因无 catch
      // 永久停在 true，之后每个带 token 的请求都被这道闸门挡下（refreshTokenDet 第二行的早退）。
      // 当前 overdueTime 被设为 +100 年，所以从未触发——这是"靠数据恰好不满足条件"掩盖的隐患。
      //
      // 现役契约里登录态由本地账号体系（auth/login + sessions 表）维护，**前端没有续期接口**；
      // 将来真要做续期，应先在现役契约下新开路由，再回到这里接上（并补 catch）。
      refreshTokenDet() {
        // 有意空实现：理由见上方注释。保留方法名，避免调用点（api/request.ts:44）报错。
      },
    };
  },
  {
    name: StoreKey.User,
    version: 2,
    migrate: (persisted: any) => {
      // 开发模式下始终使用本地管理员 token，避免旧持久化数据（dev-mock-token）导致接口 401
      if (isDev) {
        return {
          ...(persisted || {}),
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhNzkzZGE4MWYwYmZhYjhhZDVkMDY0OCIsIm1haWwiOiJhZG1pbkBhaXRvZWFybi5sb2NhbCIsIm5hbWUiOiJBZG1pbiIsImlhdCI6MTc4NjMzMDUzNiwiZXhwIjo0OTQyMDkwNTM2fQ.QUQqQ7xI935ZWF6GE6RBaNJoKUVz1S1gW1WPZCLbc1s',
          userInfo: DEV_MOCK_USER,
          overdueTime: Date.now() + 100 * 365 * 24 * 3600 * 1000,
        };
      }
      if (!persisted?.token && injectedToken) {
        return {
          ...(persisted || {}),
          token: injectedToken,
          overdueTime: Date.now() + 100 * 365 * 24 * 3600 * 1000,
        };
      }
      return persisted;
    },
  },
);
