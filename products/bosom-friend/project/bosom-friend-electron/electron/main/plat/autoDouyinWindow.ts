/*
 * 抖音自动化窗口管理器
 *
 * 评论/私信页面驱动需要一个"已登录的抖音创作者窗口"（CDP 可连接）。
 * 该窗口由主进程统一维护：独立持久化会话 + 注入账号 cookie，保持隐藏常驻，
 * 供评论页面驱动（连接 9222 调试端口）复用，避免依赖用户手动打开窗口。
 */
import { logger } from '../../global/log'
import { BrowserWindow, session } from 'electron';
import { AppDataSource } from '../../db';
import { AccountModel } from '../../db/models/account';
import { PlatType } from '../../../commont/AccountEnum';
import { clearPlatformSession } from './platformLogin';

const PARTITION = 'persist:zhiyin-douyin';
const HOME_URL = 'https://creator.douyin.com/';
// 创作者私信中心（www.douyin.com/messages 会重定向且不稳定，直接用同域聊天页）
const MESSAGES_URL = 'https://creator.douyin.com/creator-micro/data/following/chat';

let autoWin: BrowserWindow | null = null;
let messagesWin: BrowserWindow | null = null;

/**
 * 确保自动化抖音窗口存在（有抖音账号时创建）。
 * 窗口隐藏常驻，注入账号 cookie 后加载创作者后台。
 */
export async function ensureDouyinAutoWindow(): Promise<BrowserWindow | null> {
  if (autoWin && !autoWin.isDestroyed()) {
    return autoWin;
  }

  try {
    logger.info('[auto-douyin-window] 进入创建流程（无现有窗口）');
    const repo = AppDataSource.getRepository(AccountModel);
    logger.info('[auto-douyin-window] 已获取账号仓库');
    const account = await repo.findOne({
      where: { type: PlatType.Douyin as any },
    });
    logger.info('[auto-douyin-window] 已查询抖音账号:', !!account);
    if (!account?.loginCookie) return null;

    let cookies: any[] = [];
    try {
      cookies = JSON.parse(account.loginCookie);
      logger.info('[auto-douyin-window] 解析账号 cookie 数量:', cookies.length);
    } catch {
      return null;
    }

    const ses = session.fromPartition(PARTITION);
    logger.info('[auto-douyin-window] 开始写入共享分区 cookie');
    for (const c of cookies) {
      try {
        await ses.cookies.set({
          url: HOME_URL,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
        });
      } catch {
        // 单个 cookie 失败不影响整体
      }
    }
    logger.info('[auto-douyin-window] cookie 写入完成，开始创建窗口');

    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: false,
        nodeIntegration: false,
      },
    });
    logger.info('[auto-douyin-window] 窗口已创建:', win.id);
    win.webContents.setBackgroundThrottling(false);
    // 渲染崩溃自愈：置空引用并延迟重建（账号仍在时自动恢复常驻窗口）
    win.webContents.on('render-process-gone', (_event, details) => {
      logger.warn('[auto-douyin-window] 创作者窗口渲染进程退出，稍后重建:', details.reason);
      if (autoWin === win) {
        autoWin = null;
      }
      if (!win.isDestroyed()) {
        win.destroy();
      }
      setTimeout(() => {
        ensureDouyinAutoWindow().catch((e) => {
          logger.error('[auto-douyin-window] 重建创作者窗口失败:', e);
        });
      }, 8000);
    });
    // 不阻塞等待页面加载（抖音页面加载慢），窗口注册后立即继续创建其他窗口
    void win.loadURL(HOME_URL).catch((e) =>
      logger.error('[auto-douyin-window] 创作者窗口加载失败:', e),
    );
    autoWin = win;
    win.on('closed', () => {
      autoWin = null;
    });
    logger.info('[auto-douyin-window] 自动化创作者窗口已创建');

    // 私信消息窗口：供私信页面驱动读取/回复（imapi 通道失效时兜底）
    if (!messagesWin || messagesWin.isDestroyed()) {
      const msgWin = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: {
          partition: PARTITION,
          contextIsolation: false,
          nodeIntegration: false,
        },
      });
      msgWin.webContents.on('render-process-gone', (_event, details) => {
        logger.warn('[auto-douyin-window] 私信窗口渲染进程退出，稍后重建:', details.reason);
        if (messagesWin === msgWin) {
          messagesWin = null;
        }
        if (!msgWin.isDestroyed()) {
          msgWin.destroy();
        }
        setTimeout(() => {
          ensureDouyinAutoWindow().catch((e) => {
            logger.error('[auto-douyin-window] 重建私信窗口失败:', e);
          });
        }, 8000);
      });
      void msgWin.loadURL(MESSAGES_URL).catch((e) =>
        logger.error('[auto-douyin-window] 私信窗口加载失败:', e),
      );
      messagesWin = msgWin;
      msgWin.on('closed', () => {
        messagesWin = null;
      });
      logger.info('[auto-douyin-window] 私信消息窗口已创建');
    }
    return win;
  } catch (e) {
    logger.error('[auto-douyin-window] 创建失败:', e);
    return null;
  }
}

/**
 * 从自动窗口读取抖音安全令牌（privateKey/webProtect，发布链路 bd-ticket 依赖）。
 * 安全 SDK 密钥在页面加载后异步生成，这里带重试等待；拿不到返回空串（不阻断登录）。
 */
export async function readDouyinSecurityToken(win: BrowserWindow): Promise<string> {
  const read = async () => {
    const privateKey = await win.webContents.executeJavaScript(
      `(function () {
        try {
          var raw = window.localStorage['security-sdk/s_sdk_crypt_sdk'];
          if (!raw) return null;
          var outer = JSON.parse(raw);
          var inner = JSON.parse(outer.data);
          return inner.ec_privateKey || null;
        } catch (e) { return null; }
      })()`,
    );
    const webProtect = await win.webContents.executeJavaScript(
      `(function () {
        try {
          var raw = window.localStorage['security-sdk/s_sdk_sign_data_key/web_protect'];
          if (!raw) return null;
          return JSON.parse(raw).data || null;
        } catch (e) { return null; }
      })()`,
    );
    return { privateKey, webProtect };
  };
  for (let i = 0; i < 12; i++) {
    try {
      const { privateKey, webProtect } = await read();
      if (privateKey && webProtect) {
        return JSON.stringify({ privateKey, webProtect });
      }
    } catch (e) {
      logger.warn('[auto-douyin-window] 读取安全令牌失败(重试' + (i + 1) + '):', e);
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  return '';
}

/**
 * 账号 cookie 更新后刷新窗口登录态。
 */
export async function refreshDouyinAutoWindow(): Promise<void> {
  if (autoWin && !autoWin.isDestroyed()) {
    autoWin.destroy();
    autoWin = null;
  }
  if (messagesWin && !messagesWin.isDestroyed()) {
    messagesWin.destroy();
    messagesWin = null;
  }
  await ensureDouyinAutoWindow();
}

/**
 * 用自动窗口的实时会话刷新账号 cookie。
 * 页面会话（自动窗口）比历史 sqlite cookie 更新，接口判定未登录时可借此恢复。
 */
export async function refreshDouyinAccountCookie(
  target?: AccountModel,
): Promise<boolean> {
  try {
    const ses = session.fromPartition(PARTITION);
    const cookies = await ses.cookies.get({});
    // 只取抖音域 cookie：共享分区内其他平台（视频号 sessionid 同名）不混入
    const douyinCookies = cookies.filter(c => c.domain?.includes('douyin.com'));
    if (!douyinCookies.some((c) => c.name.includes('sessionid'))) {
      return false;
    }

    const nextCookie = JSON.stringify(douyinCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    })));

    const repo = AppDataSource.getRepository(AccountModel);
    const account = target ?? await repo.findOne({
      where: { type: PlatType.Douyin as any },
    });
    if (!account) {
      return false;
    }
    if (account.loginCookie === nextCookie) {
      return false;
    }

    account.loginCookie = nextCookie;
    await repo.save(account);
    logger.info('[auto-douyin-window] 已用实时窗口会话刷新账号 cookie');
    return true;
  }
  catch (e) {
    logger.error('[auto-douyin-window] 刷新账号 cookie 失败:', e);
    return false;
  }
}

/**
 * 清理抖音自动化会话（用户退出登录时调用）：
 * 关闭常驻窗口并清空持久分区 cookie/存储，避免平台会话残留。
 */
export async function clearDouyinAutoSession(): Promise<void> {
  if (autoWin && !autoWin.isDestroyed()) {
    autoWin.destroy();
    autoWin = null;
  }
  if (messagesWin && !messagesWin.isDestroyed()) {
    messagesWin.destroy();
    messagesWin = null;
  }
  hideDouyinLoginWindow();
  // 只清理抖音域 cookie：共享分区内其他平台（小红书/视频号）会话不受影响
  await clearPlatformSession(PlatType.Douyin);
}

let loginWin: BrowserWindow | null = null;
let qrRefreshTimer: NodeJS.Timeout | null = null;

function stopQrRefresh() {
  if (qrRefreshTimer) {
    clearInterval(qrRefreshTimer);
    qrRefreshTimer = null;
  }
}

/** 隐藏重新授权窗口（扫码成功或超时后调用） */
export function hideDouyinLoginWindow(): void {
  stopQrRefresh();
  if (loginWin && !loginWin.isDestroyed()) {
    // 清空页面避免被页面驱动误匹配
    void loginWin.loadURL('about:blank').catch(() => {});
    loginWin.hide();
  }
}
