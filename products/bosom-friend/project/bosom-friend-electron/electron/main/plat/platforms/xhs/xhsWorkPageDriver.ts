/**
 * 小红书作品管理页驱动 —— 采集作品真实互动数据
 *
 * 方案：复用已登录的小红书创作者窗口（CDP），打开「笔记管理」页，
 * 拦截笔记列表接口响应（edith/creator 域的 note 类接口），
 * 通过响应形状识别笔记数组（data.notes 含 note_id + interact_info），
 * 不硬编码单一端点，登录态失效时优雅返回空（由用户手动登录恢复，后台绝不弹窗）。
 */
import { logger } from '../../../../global/log'
import { SimpleWebSocket } from '../../../safety/wsClient';
import { withLocalCdp } from '../../../safety/cdpAttach';
import { BrowserWindow } from 'electron';

const CDP_BASE = 'http://127.0.0.1:9222';
const MANAGE_URL = 'https://creator.xiaohongshu.com/new/note-manager';
const PLAT_PARTITION = 'persist:zhiyin-xhs';

let workWindow: BrowserWindow | null = null;

/** 确保存在一个已登录创作者窗口（隐藏）：用于承载笔记管理页并拦截笔记列表接口 */
function ensureWorkWindow(): BrowserWindow {
  if (workWindow && !workWindow.isDestroyed()) return workWindow;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      partition: PLAT_PARTITION,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  void win.loadURL(MANAGE_URL).catch((e) => {
    logger.warn('[xhs-work-driver] 创作者窗口加载失败:', e);
  });
  // 平台页面渲染崩溃时自愈：置空引用并延迟重建，绝不让崩溃拖垮整个 APP
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.warn('[xhs-work-driver] 创作者窗口渲染进程退出，稍后重建:', details.reason);
    if (workWindow === win) {
      workWindow = null;
    }
    if (!win.isDestroyed()) {
      win.destroy();
    }
    setTimeout(() => {
      try {
        ensureWorkWindow();
      }
      catch (e) {
        logger.error('[xhs-work-driver] 重建创作者窗口失败:', e);
      }
    }, 8000);
  });
  win.on('closed', () => {
    if (workWindow === win) {
      workWindow = null;
    }
  });
  workWindow = win;
  return win;
}


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

export interface XhsWorkStatsItem {
  dataId: string;
  title?: string;
  coverUrl?: string;
  /** 作品发布时间（Unix 毫秒，用于发布日历真实日期） */
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

async function findXhsPage(): Promise<CdpPage | null> {
  try {
    const res = await fetch(`${CDP_BASE}/json/list`);
    const list = (await res.json()) as CdpPage[];
    // 优先已登录的创作者页（排除登录页）
    return (
      list.find(
        (t) =>
          (t.type === 'page' || t.type === 'webview') &&
          t.url.includes('creator.xiaohongshu.com') &&
          !t.url.includes('/login'),
      ) ||
      null
    );
  }
  catch {
    return null;
  }
}

/** 判断响应 URL 是否为笔记列表类接口（形状识别前的前置过滤） */
function isNoteListUrl(url: string): boolean {
  return (
    /note/i.test(url)
    && (url.includes('creator.xiaohongshu.com') || url.includes('edith.xiaohongshu.com'))
  );
}

/** 从接口响应体识别笔记数组（小红书创作者端笔记列表形状） */
function extractNotes(json: any): any[] {
  const notes = json?.data?.notes ?? json?.data?.note_list ?? json?.notes;
  return Array.isArray(notes) ? notes : [];
}

/** 单飞锁：并发触发共享同一轮采集结果，避免并发导航互相打断 */
let inflight: Promise<XhsWorkStatsItem[]> | null = null;

/** 采集小红书「笔记管理」页全部作品的真实互动数据（网络拦截 note 列表接口） */
export function collectXhsWorkStats(): Promise<XhsWorkStatsItem[]> {
  if (inflight)
    return inflight;
  inflight = collectOnce().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 采集核心：在同一会话内导航笔记管理页并抓取笔记列表响应（进程内会话与 9222 会话共用） */
async function captureNotes(cdp: {
  send: (method: string, params?: any) => Promise<any>;
  close: () => void;
  onMessage?: (handler: (msg: any) => void) => void;
}): Promise<XhsWorkStatsItem[]> {
  await cdp.send('Network.enable');
  const captured: string[] = [];
  const onMsg = (msg: any) => {
    if (
      msg.method === 'Network.responseReceived'
      && isNoteListUrl(msg.params?.response?.url ?? '')
    ) {
      captured.push(msg.params.requestId);
    }
  };
  if (cdp.onMessage) cdp.onMessage(onMsg);
  await cdp.send('Page.navigate', { url: MANAGE_URL });
  await sleep(9000);
  if (captured.length === 0) {
    await cdp.send('Page.reload');
    await sleep(9000);
  }
  if (captured.length === 0) {
    logger.info('[xhs-work-driver] 未捕获到笔记列表接口（可能未登录或页面改版）');
    return [];
  }

  // 合并多次响应并按 note_id 去重
  const byId = new Map<string, XhsWorkStatsItem>();
  for (const requestId of captured) {
    const body = await cdp.send('Network.getResponseBody', { requestId });
    if (!body?.body)
      continue;
    try {
      const json = JSON.parse(body.body);
      for (const note of extractNotes(json)) {
        const dataId = String(note?.note_id || note?.id || '');
        if (!dataId)
          continue;
        // 兼容两种响应形状：老接口 interact_info 嵌套、galaxy 接口顶层平铺
        const interact = note?.interact_info ?? note;
        const rawTime = Number(note?.visible_time ?? note?.time ?? note?.create_time ?? note?.last_update_time) || 0;
        // 与抖音驱动保持统一单位（Unix 秒）：xhs 接口为毫秒时归一化
        const time = rawTime > 1e12 ? Math.floor(rawTime / 1000) : rawTime;
        byId.set(dataId, {
          dataId,
          title: (note?.display_title || note?.title || '').slice(0, 50),
          coverUrl: note?.images_list?.[0]?.url ?? note?.cover?.url ?? '',
          createTime: Number(time) || undefined,
          viewCount: Number(interact?.view_count ?? interact?.viewed_count ?? 0),
          likeCount: Number(interact?.likes ?? interact?.liked_count ?? interact?.like_count ?? 0),
          commentCount: Number(interact?.comments_count ?? interact?.comment_count ?? 0),
          shareCount: Number(interact?.shared_count ?? interact?.share_count ?? 0),
          collectCount: Number(interact?.collected_count ?? interact?.collect_count ?? 0),
        });
      }
    }
    catch {
      // 单个响应解析失败不影响其他
    }
  }
  const items = Array.from(byId.values());
  logger.info('[xhs-work-driver] 采集完成：' + items.length + ' 个作品');
  return items;
}

async function collectOnce(): Promise<XhsWorkStatsItem[]> {
  // 优先主进程内创作者窗口（webContents.debugger，零端口依赖，打包版稳定）
  const isCreatorPage = (url: string) =>
    url.includes('creator.xiaohongshu.com') && !url.includes('/login');
  let local = await withLocalCdp<XhsWorkStatsItem[]>(isCreatorPage, (session) => captureNotes(session));
  if (local !== null) return local;
  // 无创作者窗口：创建隐藏窗口承载笔记管理页（会话共享分区，登录态有效则自动进入已登录状态）
  logger.info('[xhs-work-driver] 未找到创作者窗口，创建隐藏窗口采集');
  ensureWorkWindow();
  await sleep(8000);
  local = await withLocalCdp<XhsWorkStatsItem[]>(isCreatorPage, (session) => captureNotes(session));
  if (local !== null) return local;

  // 回退：9222 remote-debugging 通道（开发态/老环境）
  let page = await findXhsPage();
  if (!page?.webSocketDebuggerUrl) {
    logger.info('[xhs-work-driver] 未找到已登录的小红书创作者窗口（9222）');
    return [];
  }
  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
    return await captureNotes(cdp);
  }
  catch (e) {
    logger.error('[xhs-work-driver] 采集失败:', e);
    return [];
  }
  finally {
    cdp.close();
  }
}
