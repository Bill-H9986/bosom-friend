/**
 * 抖音云授权结果轮询器（桌面端）
 *
 * 背景：小程序授权回调经抖音云函数（authRelay）在服务端完成兑换并落库到云数据库，
 * 本模块通过云函数的 HTTP 触发器轮询结果，命中后回填到本地后端授权会话：
 * 调用本地网关 /api/v2/channels/accounts/auth/douyin/callback 完成账号绑定，
 * 使「小程序 → 云端兑换 → 桌面端轮询 → 本地绑定」整条链路无需公网服务器。
 */
import { logger } from '../../global/log';

/** 云函数 HTTP 触发器地址（在抖音云控制台创建 HTTP 触发器后填入） */
let httpTriggerUrl = '';

export function configureDouyinCloudAuth(url: string): void {
  httpTriggerUrl = url;
}

export async function pollDouyinCloudAuthResult(
  state: string,
  timeoutMs = 180000,
): Promise<any | null> {
  if (!httpTriggerUrl || !state) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        httpTriggerUrl + '?state=' + encodeURIComponent(state),
        { signal: AbortSignal.timeout(8000) },
      );
      const json: any = await res.json();
      if (json && json.ok && json.result) {
        logger.info('[douyin-cloud-auth] 云函数返回授权结果 state=', state.slice(0, 12));
        return json.result;
      }
    } catch {
      // 网络抖动继续轮询
    }
    await new Promise((s) => setTimeout(s, 3000));
  }
  return null;
}

/**
 * 把云函数兑换结果回填到本地后端授权回调（localhost 网关，@Public 接口）。
 * 返回后端响应。
 */
export async function completeLocalAuthSession(
  gatewayBase: string,
  payload: {
    state: string;
    token: string;
    nickname?: string;
    avatar?: string;
    tickets: Record<string, string>;
  },
): Promise<any> {
  const res = await fetch(
    gatewayBase.replace(/\/$/, '') +
      '/api/v2/channels/accounts/auth/douyin/callback',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return await res.json();
}