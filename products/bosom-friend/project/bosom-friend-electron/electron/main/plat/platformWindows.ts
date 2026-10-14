/**
 * 平台持久窗口：内置浏览器（embedded 引擎）里每个平台一个常驻隐藏窗口。
 *
 * 为什么必须有它：引擎的原生开页动作走的是 CDP `PUT /json/new`，开出来的是**默认会话**的标签页；
 * 而平台登录态存在各自的持久分区（`persist:zhiyin-*`）里，默认会话一次都读不到它——
 * 表现就是"每做一步都要重新登录，保存的数据一点用没有"。
 * 平台站点因此一律开进它自己的持久分区窗口：登录一次，之后每次都带着登录态。
 *
 * 分区命名与登录窗口（{@link file://./platformLogin.ts}）共用一张表，改一处就两边同时改，
 * 不允许各写一份——两处一旦分叉，登录进 A 分区、引擎读 B 分区，就又回到"要重新登录"。
 * @module electron/main/plat/platformWindows
 */
import { BrowserWindow, session } from 'electron';
import { logger } from '../../global/log';

/** 平台标识（本模块内部用，与产品频道平台的英文枚举无关）。 */
export type PlatformWindowId =
  | 'douyin'
  | 'xhs'
  | 'kwai'
  | 'wxSph'
  | 'bilibili'
  | 'baijiahao'
  | 'alipay'
  | 'weibo'
  | 'hupu';

/** 一个平台的持久分区窗口规格。 */
export interface PlatformWindowSpec {
  id: PlatformWindowId;
  /** 展示名（日志与界面上用中文）。 */
  label: string;
  /** 归属域名（按后缀匹配）：把 URL 路由到对应分区。 */
  hosts: string[];
  /** 打开窗口时的落地页。 */
  homeUrl: string;
}

/** 分区表：**登录窗口与引擎窗口共用**，键是平台标识，值是 Electron 持久分区名。 */
export const PLATFORM_PARTITIONS: Record<PlatformWindowId, string> = {
  douyin: 'persist:zhiyin-douyin',
  xhs: 'persist:zhiyin-xhs',
  kwai: 'persist:zhiyin-kwai',
  wxSph: 'persist:zhiyin-wxsph',
  bilibili: 'persist:zhiyin-bilibili',
  baijiahao: 'persist:zhiyin-baijiahao',
  alipay: 'persist:zhiyin-alipay',
  weibo: 'persist:zhiyin-weibo',
  hupu: 'persist:zhiyin-hupu',
};

/** 平台清单：域名只写注册域后缀，匹配时按后缀比对（creator./www. 等子域都算同一平台）。 */
export const PLATFORM_WINDOWS: PlatformWindowSpec[] = [
  { id: 'douyin', label: '抖音', hosts: ['douyin.com'], homeUrl: 'https://creator.douyin.com/' },
  { id: 'xhs', label: '小红书', hosts: ['xiaohongshu.com'], homeUrl: 'https://creator.xiaohongshu.com/' },
  { id: 'kwai', label: '快手', hosts: ['kuaishou.com'], homeUrl: 'https://cp.kuaishou.com/' },
  { id: 'wxSph', label: '视频号', hosts: ['channels.weixin.qq.com'], homeUrl: 'https://channels.weixin.qq.com/' },
  { id: 'bilibili', label: '哔哩哔哩', hosts: ['bilibili.com'], homeUrl: 'https://member.bilibili.com/' },
  { id: 'baijiahao', label: '百家号', hosts: ['baijiahao.baidu.com'], homeUrl: 'https://baijiahao.baidu.com/' },
  { id: 'alipay', label: '支付宝生活号', hosts: ['alipay.com'], homeUrl: 'https://open.alipay.com/' },
  { id: 'weibo', label: '微博', hosts: ['weibo.com'], homeUrl: 'https://weibo.com/' },
  { id: 'hupu', label: '虎扑', hosts: ['hupu.com'], homeUrl: 'https://bbs.hupu.com/' },
];

/** 平台窗口缓存：一个平台一个常驻窗口，进程内复用。 */
const windows = new Map<PlatformWindowId, BrowserWindow>();

/** 从主机名解析平台规格；不属于任何已登记平台时返回 null。 */
export function platformSpecForHost(host: string): PlatformWindowSpec | null {
  const normalized = host.trim().toLowerCase();
  if (normalized === '')
    return null;
  return (
    PLATFORM_WINDOWS.find(spec =>
      spec.hosts.some(item => normalized === item || normalized.endsWith('.' + item)),
    ) ?? null
  );
}

/** 从完整 URL 解析平台规格；URL 不合法或平台未登记时返回 null。 */
export function platformSpecForUrl(url: string): PlatformWindowSpec | null {
  try {
    return platformSpecForHost(new URL(url).hostname);
  }
  catch {
    return null;
  }
}

/**
 * 取（必要时创建）某平台的持久窗口。
 *
 * 窗口隐藏常驻、使用该平台的持久分区：登录态写在磁盘上，重启应用后仍在。
 * 同一个平台只建一个窗口；被外部关掉后下次调用会重建。
 *
 * @param spec - 平台规格。
 * @returns 可用的窗口；创建失败时返回 null（调用方回退原有行为，不让整条链路失败）。
 */
export function ensurePlatformWindow(spec: PlatformWindowSpec): BrowserWindow | null {
  const existing = windows.get(spec.id);
  if (existing !== undefined && !existing.isDestroyed())
    return existing;
  try {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        partition: PLATFORM_PARTITIONS[spec.id],
        contextIsolation: false,
        nodeIntegration: false,
      },
    });
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('render-process-gone', (_event, details) => {
      logger.warn('[platform-window] ' + spec.label + ' 窗口渲染进程退出，稍后重建：' + details.reason);
      if (windows.get(spec.id) === win)
        windows.delete(spec.id);
      if (!win.isDestroyed())
        win.destroy();
    });
    win.on('closed', () => {
      if (windows.get(spec.id) === win)
        windows.delete(spec.id);
    });
    windows.set(spec.id, win);
    void win.loadURL(spec.homeUrl).catch((e) => {
      logger.error('[platform-window] ' + spec.label + ' 窗口加载失败：' + String(e));
    });
    logger.info('[platform-window] 已建立 ' + spec.label + ' 持久窗口（分区 ' + PLATFORM_PARTITIONS[spec.id] + '）');
    return win;
  }
  catch (error) {
    logger.error('[platform-window] 创建 ' + spec.label + ' 窗口失败：' + String(error));
    return null;
  }
}

/**
 * 按 URL 取（必要时创建）对应平台的持久窗口。
 *
 * @param url - 目标地址。
 * @returns 平台窗口；该地址不属于已登记平台时返回 null。
 */
export function ensurePlatformWindowForUrl(url: string): BrowserWindow | null {
  const spec = platformSpecForUrl(url);
  return spec === null ? null : ensurePlatformWindow(spec);
}

/**
 * 把所有平台分区的 cookie 落盘。
 *
 * Electron 平时异步写盘，进程被强杀（安装更新、任务管理器结束）时最后一段登录态会丢；
 * 退出前显式 flush 一次，避免"刚登录完关掉应用，下次打开又要登录"。
 *
 * @returns 全部 flush 完成后 resolve（单个分区失败不阻断其它分区）。
 */
export async function flushPlatformCookies(): Promise<void> {
  await Promise.all(Object.values(PLATFORM_PARTITIONS).map(async (partition) => {
    try {
      await session.fromPartition(partition).cookies.flushStore();
    }
    catch (error) {
      logger.warn('[platform-window] 分区 ' + partition + ' cookie 落盘失败：' + String(error));
    }
  }));
}

/** 关闭全部平台窗口（应用退出时调用；不删分区，登录态留在磁盘上）。 */
export function closePlatformWindows(): void {
  for (const [id, win] of windows) {
    if (!win.isDestroyed())
      win.destroy();
    windows.delete(id);
  }
}
