/**
 * CDP 客户端 —— 连接外部 Chrome / Edge 调试端口
 *
 * 复用私信页面驱动同款极简 WebSocket 实现（SimpleWebSocket），
 * 提供页面发现 / 新开网址 / 执行脚本能力，供自动化链路对接外部浏览器。
 */
import { SimpleWebSocket } from '../safety/wsClient';

export interface CdpTarget {
  id?: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

export interface CdpSession {
  send: (method: string, params?: any) => Promise<any>;
  close: () => void;
}

/** 读取浏览器所有 CDP target */
export async function getTargets(port: number): Promise<CdpTarget[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? (list as CdpTarget[]) : [];
  } catch {
    return [];
  }
}

/** 在目标浏览器新开标签页（返回 target） */
export async function openUrl(
  port: number,
  url: string,
): Promise<CdpTarget | null> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' },
    );
    if (!res.ok) return null;
    return (await res.json()) as CdpTarget;
  } catch {
    return null;
  }
}

/** 按条件查找目标页面 */
export async function findTarget(
  port: number,
  predicate: (t: CdpTarget) => boolean,
): Promise<CdpTarget | null> {
  const targets = await getTargets(port);
  return targets.find(predicate) || null;
}

/** 连接目标页面 WebSocket */
export function connectCdp(wsUrl: string): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    void SimpleWebSocket.connect(wsUrl)
      .then((ws) => {
        let id = 0;
        const pending = new Map<number, (v: any) => void>();
        ws.onMessage((msg: any) => {
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)!(msg.result);
            pending.delete(msg.id);
          }
        });
        resolve({
          send: (method, params = {}) =>
            new Promise((res) => {
              const mid = ++id;
              pending.set(mid, res);
              ws.send({ id: mid, method, params });
            }),
          close: () => ws.close(),
        });
      })
      .catch(reject);
  });
}

/** 在指定页面执行 JS，返回求值结果（自动化探测用） */
export async function evaluateOnPage(
  port: number,
  urlPattern: RegExp,
  expression: string,
): Promise<any | undefined> {
  const targets = await getTargets(port);
  const page = targets.find(
    (t) => (t.type === 'page' || t.type === 'webview') && urlPattern.test(t.url),
  );
  if (!page?.webSocketDebuggerUrl) return undefined;
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r?.result?.value;
  } finally {
    cdp.close();
  }
}
