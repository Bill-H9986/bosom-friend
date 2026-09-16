/**
 * 抖音作品管理页驱动 —— 采集作品真实互动数据
 *
 * 方案：复用已登录的抖音窗口（CDP），刷新作品管理页，
 * 用 Network 拦截捕获作品列表接口 `/janus/douyin/creator/pc/work_list`
 * 的真实响应（aweme_list 含 aweme_id + statistics 完整互动数据），
 * 比解析页面 DOM 更稳定、数据更全。
 */

const CDP_BASE = 'http://127.0.0.1:9222';
const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage';
import { logger } from '../../../../global/log'
import { SimpleWebSocket } from '../../../safety/wsClient';

interface CdpPage {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface CdpSession {
  send: (method: string, params?: any) => Promise<any>;
  close: () => void;
  ws: any;
}

export interface WorkStatsItem {
  dataId: string;
  title?: string;
  /** 作品发布时间（Unix 秒，用于发布日历真实日期） */
  createTime?: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  collectCount: number;
}

function connect(wsUrl: string): Promise<CdpSession> {
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
          ws,
        });
      })
      .catch(reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function findManagePage(): Promise<CdpPage | null> {
  try {
    const res = await fetch(`${CDP_BASE}/json/list`);
    const list = (await res.json()) as CdpPage[];
    return (
      list.find(
        (t) =>
          (t.type === 'page' || t.type === 'webview') &&
          t.url.includes('creator.douyin.com') &&
          t.url.includes('content/manage') &&
          !t.url.includes('/content/upload') &&
          !t.url.includes('/content/post/'),
      ) ||
      list.find(
        (t) =>
          (t.type === 'page' || t.type === 'webview') &&
          t.url.includes('creator.douyin.com') &&
          !t.url.includes('/content/upload') &&
          !t.url.includes('/content/post/') &&
          !t.url.includes('/data/following/chat'),
      ) ||
      null
    );
  } catch {
    return null;
  }
}

/** 单飞锁：定时同步/手动同步/发布后回填可能并发触发，共享同一轮采集结果，避免并发导航互相打断 */
let inflight: Promise<WorkStatsItem[]> | null = null;

/** 采集抖音作品管理页全部作品的真实互动数据（网络拦截 work_list 接口） */
export function collectDouyinWorkStats(): Promise<WorkStatsItem[]> {
  if (inflight)
    return inflight;
  inflight = collectOnce().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function collectOnce(): Promise<WorkStatsItem[]> {
  const page = await findManagePage();
  if (!page?.webSocketDebuggerUrl) {
    logger.info('[work-page-driver] 未找到已登录的抖音窗口（9222）');
    return [];
  }
  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
    await cdp.send('Network.enable');
    const captured: string[] = [];
    cdp.ws.onMessage((msg: any) => {
      if (
        msg.method === 'Network.responseReceived' &&
        msg.params?.response?.url?.includes('/janus/douyin/creator/pc/work_list')
      ) {
        captured.push(msg.params.requestId);
      }
    });
    // 导航到作品管理页并等待作品列表接口返回
    await cdp.send('Page.navigate', { url: MANAGE_URL });
    await sleep(9000);
    if (captured.length === 0) {
      // 页面可能已停留：强制刷新一次
      await cdp.send('Page.reload');
      await sleep(9000);
    }
    if (captured.length === 0) {
      logger.info('[work-page-driver] 未捕获到作品列表接口（可能未登录）');
      return [];
    }
    // 滚动触发分页加载：作品管理页滚动到底部会自动请求下一页，
    // 滚动 3 屏可采集到更多历史作品（接口响应由上方监听器捕获）
    for (let i = 0; i < 3; i++) {
      await cdp.send('Runtime.evaluate', {
        expression: 'window.scrollTo(0, document.body.scrollHeight)',
      });
      await sleep(3000);
    }
    // 合并多次响应（分页/多状态）并按 aweme_id 去重
    const byId = new Map<string, WorkStatsItem>();
    for (const requestId of captured) {
      const body = await cdp.send('Network.getResponseBody', { requestId });
      if (!body?.body) continue;
      try {
        const json = JSON.parse(body.body);
        const list = json?.aweme_list ?? [];
        for (const w of list) {
          const dataId = String(w?.aweme_id || w?.item_id || '')
          if (!dataId) continue
          byId.set(dataId, {
            dataId,
            title: (w?.desc || w?.title || '').slice(0, 50),
            createTime: Number(w?.create_time) || undefined,
            viewCount: Number(w?.statistics?.play_count ?? 0),
            likeCount: Number(w?.statistics?.digg_count ?? 0),
            commentCount: Number(w?.statistics?.comment_count ?? 0),
            shareCount: Number(w?.statistics?.share_count ?? 0),
            collectCount: Number(w?.statistics?.collect_count ?? 0),
          })
        }
      } catch {
        // 单个响应解析失败不影响其他
      }
    }
    const items = Array.from(byId.values())
    logger.info(
      `[work-page-driver] 采集完成：${items.length} 个作品（播放/点赞/评论/分享/收藏）`,
    );
    return items;
  } catch (e) {
    logger.error('[work-page-driver] 采集失败:', e);
    return [];
  } finally {
    cdp.close();
  }
}
