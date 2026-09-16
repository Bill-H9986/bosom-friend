/**
 * 平台页面 CDP 会话统一获取器
 *
 * 背景：签名/发布/采集各驱动此前一律依赖 9222 remote-debugging 端口，
 * 该端口可能未随打包版启动或被 browser-control 引擎争抢，导致
 * 「xhs-inpage-signer 30 秒未找到签名窗口 → xhs API 404 → 账号数据不更新」。
 * 方案：优先复用主进程内已打开的平台窗口（webContents.debugger，零端口依赖，
 * 打包版稳定可用）；本模块匹配不到时由调用方回退到 9222（开发态兼容）。
 */
import { BrowserWindow } from 'electron';

export interface CdpSession {
  send(method: string, params?: any): Promise<any>;
  close(): void;
  /** 订阅 CDP 事件（如 Network.responseReceived） */
  onMessage?: (handler: (msg: any) => void) => void;
}

/** 在主进程窗口里查找匹配页面（url 为空/草稿页视窗口创建状态处理） */
export function findLocalPage(
  match: (url: string, win: BrowserWindow) => boolean,
): BrowserWindow | null {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    let url = '';
    try {
      url = win.webContents.getURL();
    } catch {
      continue;
    }
    try {
      if (match(url, win)) return win;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 以进程内会话执行操作；匹配不到页面或 attach 失败返回 null，
 * 调用方据此回退到 9222 端口通道。
 */
export async function withLocalCdp<T>(
  match: (url: string, win: BrowserWindow) => boolean,
  fn: (session: CdpSession) => Promise<T>,
): Promise<T | null> {
  const win = findLocalPage(match);
  if (!win) return null;
  const wc = win.webContents;
  if (wc.isDestroyed()) return null;
  try {
    wc.debugger.attach('1.3');
    const listeners = new Set<(msg: any) => void>();
    const onEvent = (_event: unknown, method: string, params: unknown) => {
      for (const h of listeners) h({ method, params } as never);
    };
    wc.debugger.on('message', onEvent as never);
    const session: CdpSession = {
      send: (method: string, params: any = {}) => wc.debugger.sendCommand(method, params),
      close: () => {
        try {
          wc.debugger.removeListener('message', onEvent as never);
        } catch {
          /* 已卸载 */
        }
        try {
          wc.debugger.detach();
        } catch {
          /* 已断开 */
        }
      },
      onMessage: (handler) => {
        listeners.add(handler);
      },
    };
    return await fn(session);
  } catch {
    try {
      wc.debugger.detach();
    } catch {
      /* 已断开 */
    }
    return null;
  }
}
