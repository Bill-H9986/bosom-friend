/**
 * 官方插件式平台登录窗口
 *
 * 对齐官方浏览器插件流程：打开平台创作者页（共享持久分区，官方自动化引擎在其中运行），
 * 用户在网页上正常完成登录（扫码/账号密码），主进程自动检测登录 cookie 并返回，
 * 由调用方保存账号并同步到频道列表。关闭窗口 = 取消登录。
 */
import { BrowserWindow, session } from 'electron';
import { logger } from '../../global/log';
import { PlatType } from '../../../commont/AccountEnum';
import { ensureDouyinAutoWindow } from './autoDouyinWindow';
import platController from './index';
import type { AccountModel } from '../../db/models/account';

/** 各平台独立持久分区：避免多平台窗口与主进程并发读写同一 cookie 库引发原生崩溃 */
const PLAT_PARTITIONS: Partial<Record<PlatType, string>> = {
  [PlatType.Douyin]: 'persist:zhiyin-douyin',
  [PlatType.Xhs]: 'persist:zhiyin-xhs',
};

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

interface LoginTarget {
  url: string;
  title: string;
  partition: string;
  hasLoggedIn: (cookies: Electron.Cookie[]) => boolean;
  /** 判定 cookie 是否属于该平台（按域隔离，共享分区内分平台清理会话用） */
  isPlatformCookie: (cookie: Electron.Cookie) => boolean;
  /** 复用常驻自动窗口（抖音），不新建窗口 */
  reuseAutoWindow?: boolean;
}

const TARGETS: Partial<Record<PlatType, LoginTarget>> = {
  [PlatType.Douyin]: {
    url: 'https://creator.douyin.com/',
    title: '抖音创作者中心',
    partition: PLAT_PARTITIONS[PlatType.Douyin]!,
    hasLoggedIn: cookies => cookies.some(c => c.name.includes('sessionid') && c.value !== ''),
    isPlatformCookie: cookie => cookie.domain?.includes('douyin.com') ?? false,
    reuseAutoWindow: true,
  },
  [PlatType.Xhs]: {
    // 创作者登录页（creator.xiaohongshu.com/login）在本环境只有短信登录、无二维码，
    // 用户无法扫码；www 登录页稳定显示二维码，登录后 cookie 同属 xiaohongshu.com
    // 域，创作者平台（edith）接口可直接使用，登录体验对齐「扫码即登录」。
    url: 'https://www.xiaohongshu.com/login',
    title: '小红书创作服务平台',
    partition: PLAT_PARTITIONS[PlatType.Xhs]!,
    // 登录判据：网页登录产出 web_session（access-token 仅移动端/特定流程才有），
    // 只认 access-token 会导致网页登录成功却永远被判未登录
    hasLoggedIn: cookies => cookies.some(c => c.name === 'web_session' && c.value !== '')
      || cookies.some(c => c.name.includes('access-token') && c.value !== ''),
    isPlatformCookie: cookie => (cookie.domain?.includes('xiaohongshu.com') ?? false)
      || (cookie.domain?.includes('xhscdn.com') ?? false),
  },
};

/**
 * 检查共享分区内该平台会话是否有效（官方插件式登录的在线判据）。
 * 仅以浏览器会话 cookie 为准：平台 API 抖动/限流（500/风控）不应把账号
 * 状态翻成「离线」误导用户——真正的会话失效由各链路 API 错误自行降级处理；
 * 「cookie 在但会话已死」的复核保留在用户手动登录入口 openPlatformLogin。
 */
export async function isPlatformSessionValid(type: PlatType): Promise<boolean> {
  const target = TARGETS[type];
  if (!target)
    return false;
  try {
    const ses = session.fromPartition(target.partition);
    const cookies = await ses.cookies.get({});
    return target.hasLoggedIn(cookies);
  }
  catch {
    return false;
  }
}

/**
 * 按平台清理登录会话：共享分区内只删除该平台的 cookie，不影响其他平台。
 */
export async function clearPlatformSession(type: PlatType): Promise<void> {
  const target = TARGETS[type];
  if (!target)
    return;
  try {
    const ses = session.fromPartition(target.partition);
    const cookies = await ses.cookies.get({});
    for (const cookie of cookies) {
      if (target.isPlatformCookie(cookie)) {
        await ses.cookies.remove(target.url, cookie.name).catch(() => {});
      }
    }
    await ses.cookies.flushStore().catch(() => {});
    logger.info('[platform-login] 已清理平台会话:', type);
  }
  catch (e) {
    logger.error('[platform-login] 清理平台会话失败:', type, e);
  }
}

/** 序列化 cookie（与平台登录保存格式一致） */
export function serializeLoginCookies(cookies: Electron.Cookie[]): string {
  return JSON.stringify(
    cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    })),
  );
}

/**
 * 用平台 API 二次确认共享分区会话是否真正有效（cookie 存在 ≠ 会话有效，
 * 过期残留的 access-token 会让 hasLoggedIn 误判，导致登录窗口打不开、
 * 自动接待/发布全部 404/406 假死）。
 */
async function verifySessionByApi(
  type: PlatType,
  cookies: Electron.Cookie[],
): Promise<'online' | 'offline' | 'unreachable'> {
  try {
    const fake = {
      type,
      loginCookie: JSON.stringify(cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }))),
    } as unknown as AccountModel;
    const res = (await Promise.race([
      platController.platLoginCheck(type, fake).catch(() => ({ online: false, unreachable: true })),
      new Promise<{ online: boolean; unreachable?: boolean }>(resolve => setTimeout(() => resolve({ online: false, unreachable: true }), 8000)),
    ])) as { online?: boolean; unreachable?: boolean };
    if (res?.unreachable) return 'unreachable';
    return res?.online ? 'online' : 'offline';
  }
  catch {
    return 'unreachable';
  }
}
/** 进行中的平台登录窗口（供取消登录时关闭并结束等待） */
const activeLoginWindows = new Map<PlatType, BrowserWindow>();
/** 进行中的登录流程取消器（结束等待但不销毁窗口） */
const activeLoginCancellers = new Map<PlatType, () => void>();
/** 进行中的登录流程 Promise（同平台并发去重，快速连点复用同一等待） */
const openInFlight = new Map<PlatType, Promise<Electron.Cookie[] | null>>();

/**
 * 取消平台登录：立即结束等待（登录 Promise 返回 null）。
 * 不销毁登录窗口——用户可能仍在扫码，窗口反复消失会打断登录；
 * 后续任一路径（看门狗/重新点登录）都会通过共享分区 cookie 检测到已登录会话。
 */
export function cancelPlatformLogin(type: PlatType): void {
  const cancel = activeLoginCancellers.get(type);
  if (cancel) {
    cancel();
  }
  logger.info('[platform-login] 登录流程已取消，窗口保持打开等待扫码:', type);
}

/**
 * 打开平台登录窗口并等待登录完成。
 * 同一平台并发调用去重：已有进行中的登录流程时复用窗口与等待 Promise，快速连点只产生一个窗口。
 * @returns 登录成功返回该分区的全部 cookie；取消/超时返回 null
 */
export function openPlatformLogin(type: PlatType): Promise<Electron.Cookie[] | null> {
  const inFlight = openInFlight.get(type);
  if (inFlight) {
    // 已有进行中的登录流程：不新建窗口，复用现有窗口与同一等待 Promise。
    const win = activeLoginWindows.get(type);
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
    logger.info('[platform-login] 登录已在进行中，复用现有窗口与等待:', type);
    return inFlight;
  }

  logger.info('[platform-login] 开始打开登录窗口:', type);
  const pending = doOpenPlatformLogin(type);
  openInFlight.set(type, pending);
  void pending.finally(() => {
    openInFlight.delete(type);
  });
  return pending;
}

async function doOpenPlatformLogin(type: PlatType): Promise<Electron.Cookie[] | null> {
  const target = TARGETS[type];
  if (!target) {
    logger.error('[platform-login] 不支持的平台:', type);
    return null;
  }

  const ses = session.fromPartition(target.partition);
  logger.info('[platform-login] 已获取共享分区会话:', type);

  // 官方「同步」语义：共享分区已有登录态时直接返回 cookie，无需再开窗口。
  // 只返回该平台域的 cookie，避免跨平台 cookie 串扰（视频号 sessionid 误判抖音等）
  // 注意：cookie 存在不等于会话有效——过期残留的 access-token 会误判已登录，
  // 导致登录窗口打不开而平台 API 全部 404/406，自动接待与发布假死。
  try {
    logger.info('[platform-login] 开始检查已有 cookie:', type);
    const existing = await ses.cookies.get({});
    logger.info('[platform-login] 已有 cookie 读取完成:', type, existing.length);
    const platformCookies = existing.filter(target.isPlatformCookie);
    logger.info(
      '[platform-login] 平台 cookie 过滤完成:',
      type,
      platformCookies.length,
      'hasSession:',
      target.hasLoggedIn(platformCookies),
    );
    if (target.hasLoggedIn(platformCookies)) {
      // API 复核确认会话真正有效才直接同步；cookie 存在但 API 离线（会话已失效的
      // 过期残留）时继续往下打开登录窗口——人为触发的登录允许弹窗，避免「
      // 一直显示已登录却打不开登录窗、平台接口全部 401/404 假死」的死循环。
      const apiOnline = await verifySessionByApi(type, platformCookies);
      logger.info('[platform-login] API 复核结果:', type, apiOnline);
      if (apiOnline === 'online') {
        logger.info('[platform-login] 平台已登录（cookie 判定 + API 复核均通过），直接同步会话:', type);
        return platformCookies;
      }
      logger.info('[platform-login] cookie 存在但 API 复核离线（会话已失效），打开登录窗口等待重新扫码:', type);
    }
  }
  catch (e) {
    logger.error('[platform-login] 检查已有会话失败:', e);
  }

  let win: BrowserWindow | null = null;
  let reusedAutoWindow = false;
  try {
    if (target.reuseAutoWindow) {
      win = await ensureDouyinAutoWindow();
      reusedAutoWindow = !!win && !win.isDestroyed();
    }
    if (!win || win.isDestroyed()) {
      logger.info('[platform-login] 创建独立登录窗口:', type);
      win = new BrowserWindow({
        width: 1080,
        height: 760,
        title: target.title,
        webPreferences: {
          partition: target.partition,
          contextIsolation: false,
          nodeIntegration: false,
        },
      });
      // 使用标准 Chrome UA，避免小红书/抖音登录页检测到 Electron 环境后拒绝/拦截
      win.webContents.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      );
      void win.loadURL(target.url).catch((e) => {
        logger.error('[platform-login] 登录页加载失败:', e);
      });
    }
    win.show();
    win.focus();
    win.center();
    logger.info('[platform-login] 登录窗口已展示，等待扫码:', type, win.id);
    // 登录页渲染崩溃按「取消登录」处理：关闭窗口触发 closed → finish(null)，避免等待挂死
    win.webContents.on('render-process-gone', (_event, details) => {
      logger.warn('[platform-login] 登录窗口渲染进程退出:', type, details.reason);
      if (win && !win.isDestroyed()) {
        win.close();
      }
    });
    activeLoginWindows.set(type, win);
  }
  catch (e) {
    logger.error('[platform-login] 创建登录窗口失败:', e);
    return null;
  }

/** 会话关键 cookie（登录态载体）：页面加载会刷新 loadts/acw_tc 等噪声 cookie，
 * 快照只比对这些字段，避免把普通页面活动误判为登录完成。 */
const SESSION_COOKIE_NAMES = [
  'web_session',
  'id_token',
  'access-token',
  'sessionid',
  'sessionid_ss',
  'passport_auth_status',
];

function sessionSnapshot(cookies: Electron.Cookie[]): string {
  return JSON.stringify(
    cookies
      .filter((c) => SESSION_COOKIE_NAMES.includes(c.name))
      .map((c) => c.name + '=' + c.value)
      .sort(),
  );
}
  // 打开窗口前的 cookie 快照：会话已失效（API 复核离线）时，只有快照发生变化
  // （重新登录必然轮换 web_session 等会话 cookie）才判定登录完成，
  // 避免轮询把过期残留 cookie 误判为「已登录」而立即关窗（曾导致登录窗口打不开）。
  let staleSnapshot = '';
  try {
    const before = await ses.cookies.get({});
    staleSnapshot = sessionSnapshot(before.filter(target.isPlatformCookie));
  }
  catch {
    staleSnapshot = '';
  }

  return new Promise((resolve) => {    let settled = false;
    const finish = (result: Electron.Cookie[] | null) => {
      if (settled)
        return;
      settled = true;
      clearInterval(timer);
      activeLoginWindows.delete(type);
      activeLoginCancellers.delete(type);
      if (result) {
        // 登录成功：落盘会话（永久保存），并关闭独立登录窗口（登录完成即收窗，符合「只弹一次」）。
        void ses.cookies.flushStore().catch((e) => {
          logger.error('[platform-login] 会话落盘失败:', type, e);
        });
        if (!reusedAutoWindow && win && !win.isDestroyed()) {
          win.close();
        }
      }
      // 失败/取消：不清除任何会话；复用常驻窗口（抖音）保留供自动接待继续使用。
      resolve(result);
    };

    // API 复核节流：避免每 2 秒轮询都打平台接口（小红书签名接口限频）
    let lastApiCheckAt = 0;
    const API_CHECK_INTERVAL_MS = 5000;

    const timer = setInterval(async () => {
      try {
        const all = await ses.cookies.get({});
        // 只判定/返回该平台域 cookie，避免其他平台同名 cookie 干扰
        const platformCookies = all.filter(target.isPlatformCookie);
        if (target.hasLoggedIn(platformCookies)) {
          const snapshot = sessionSnapshot(platformCookies);
          // 会话快照未变化 = 仍是打开窗口前的过期残留，继续等待真实登录
          if (staleSnapshot && snapshot === staleSnapshot) {
            return;
          }
          // 关键防线：小红书未登录页也会自动轮换 web_session，仅凭 cookie 快照
          // 变化会误判「假登录」并覆盖账号会话。必须平台 API 复核确认会话真正
          // 有效才算登录成功（抖音接口快、小红书走页面内签名，均安全）。
          const now = Date.now();
          if (now - lastApiCheckAt >= API_CHECK_INTERVAL_MS) {
            lastApiCheckAt = now;
            const apiOnline = await verifySessionByApi(type, platformCookies);
            // 小红书：官方网页登录后会跳转离开 /login，此信号比 API 复核更可靠。
            // API 复核有签名/反爬限制，可能永远报不可达，不再让它卡死登录。
            let loginConfirmed = apiOnline === 'online';
            if (!loginConfirmed && type === PlatType.Xhs) {
              const currentUrl = win && !win.isDestroyed()
                ? win.webContents.getURL()
                : '';
              loginConfirmed = currentUrl.startsWith('https://www.xiaohongshu.com')
                && !currentUrl.includes('/login');
            }
            if (!loginConfirmed) {
              logger.info(
                '[platform-login] cookie 快照变化但登录尚未确认，继续等待:',
                type,
                apiOnline,
              );
              return;
            }
          }
          else {
            return;
          }
          // 检测到登录的瞬间立即落盘会话（此前多次因同步流程崩溃导致 cookie 丢失），
          // 保证「一次登录永久保存」不依赖后续同步是否成功
          await ses.cookies.flushStore().catch(() => {});
          finish(platformCookies);
        }
      }
      catch (e) {
        logger.error('[platform-login] 检测登录状态失败:', e);
      }
    }, POLL_INTERVAL_MS);

    activeLoginCancellers.set(type, () => finish(null));

    win.on('closed', () => {
      activeLoginWindows.delete(type);
      activeLoginCancellers.delete(type);
      finish(null);
    });

    setTimeout(() => {
      if (!settled) {
        // 登录等待不强制关闭窗口：用户可能稍后才扫码，窗口消失会反复打断登录。
        // 会话检测轮询继续运行，用户完成登录即自动同步；窗口被用户手动关闭时自然结束等待。
        logger.info('[platform-login] 登录等待已超过 10 分钟，窗口保持打开等待扫码:', type);
      }
    }, LOGIN_TIMEOUT_MS);
  });
}
