/*
 * Bosom Friend AI 内容创作营销系统 - 全局网络状态
 * 用于替代阻塞式 message.error 弹窗：
 * 网络异常时仅点亮轻量横幅，请求恢复后自动清除
 */
import { create } from 'zustand';

interface INetStatusStore {
  /** 是否处于网络异常状态 */
  offline: boolean;
  /** 异常提示文案 */
  message: string;
  /** 标记网络异常（幂等，重复触发不会叠加弹窗） */
  markOffline: (msg?: string) => void;
  /** 网络恢复 / 用户手动关闭 */
  clear: () => void;
}

export const useNetStatusStore = create<INetStatusStore>((set) => ({
  offline: false,
  message: '',
  markOffline: (msg) =>
    set({
      offline: true,
      message: msg || '网络连接异常，内容可能未同步，请检查网络后重试',
    }),
  clear: () => set({ offline: false, message: '' }),
}));
