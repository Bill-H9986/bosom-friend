/**
 * 小红书页面内签名器
 *
 * 背景：外部签名服务器（116.62.154.231:7879）已失效（HTTP 404），
 * 所有依赖 X-S/X-T 的 xhs 接口（用户信息/作品/评论/私信/发布）全部瘫痪。
 * 方案：保持一个 www.xiaohongshu.com 隐藏窗口（共享分区），通过 CDP 调用
 * 页面自带的 window._webmsxyw 生成签名——签名逻辑由小红书官方页面维护，
 * 无需第三方服务，随页面自动升级。
 */
import { BrowserWindow } from 'electron';
import { logger } from '../../global/log';
import { SimpleWebSocket } from '../safety/wsClient';
import { findLocalPage, withLocalCdp } from '../safety/cdpAttach';

const CDP_BASE = 'http://127.0.0.1:9222';
const SIGNER_URL = 'https://www.xiaohongshu.com/';
const PLAT_PARTITION = 'persist:zhiyin-xhs';

const SIGNER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let signerWindow: BrowserWindow | null = null;

/** 确保签名窗口存在（隐藏常驻，加载 www 首页以加载签名器 bundle） */
async function ensureSignerWindow(): Promise<BrowserWindow> {
  if (signerWindow && !signerWindow.isDestroyed())
    return signerWindow;
  signerWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      partition: PLAT_PARTITION,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  // 隐藏窗口禁用后台节流：否则页面 JS/网络会被 Chromium 节流，签名 SDK 永远加载不出来
  signerWindow.webContents.setBackgroundThrottling(false);
  void signerWindow.loadURL(SIGNER_URL).catch((e) => {
    logger.error('[xhs-inpage-signer] 签名窗口加载失败:', e);
  });
  signerWindow.on('closed', () => {
    signerWindow = null;
  });
  return signerWindow;
}

function connectCdp(wsUrl: string): Promise<{ send: (method: string, params?: any) => Promise<any>; close: () => void }> {
  return new Promise((resolve, reject) => {
    void SimpleWebSocket.connect(wsUrl).then((ws) => {
      let id = 0;
      const pending = new Map<number, (v: any) => void>();
      ws.onMessage((msg: any) => {
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg.result);
          pending.delete(msg.id);
        }
      });
      resolve({
        send: (method: string, params: any = {}) =>
          new Promise((res) => {
            const mid = ++id;
            pending.set(mid, res);
            ws.send({ id: mid, method, params });
          }),
        close: () => ws.close(),
      });
    }).catch(reject);
  });
}

/** 在签名窗口（或任意已打开的 xhs 页面）上下文执行表达式；等待 _webmsxyw 就绪 */
async function evaluateInSignerViaRemote(expression: string): Promise<any> {
  const deadline = Date.now() + 30000;
  let navigatedBlank = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(CDP_BASE + '/json/list');
      const list = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      // 候选：任何 xhs 页面；加载中的签名窗口 url 可能为空或 about:blank，同样纳入
      const page = list.find(
        (t) => t.type === 'page' && (t.url.includes('xiaohongshu.com') || t.url === '' || t.url === 'about:blank'),
      );
      if (page?.webSocketDebuggerUrl) {
        const cdp = await connectCdp(page.webSocketDebuggerUrl);
        try {
          // 空白/未加载的窗口：主动导航到小红书首页，避免永远等不到签名函数
          if ((page.url === '' || page.url === 'about:blank') && !navigatedBlank) {
            navigatedBlank = true;
            await cdp.send('Page.navigate', { url: SIGNER_URL }).catch(() => {});
            await new Promise((s) => setTimeout(s, 2000));
          }
          const r = await cdp.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          const value = r?.result?.value;
          // 签名函数未就绪（页面仍在加载）→ 继续重试
          if (value === 'NOT_READY') {
            await new Promise((s) => setTimeout(s, 1000));
            continue;
          }
          return value;
        } finally {
          cdp.close();
        }
      }
    } catch {
      // 重试
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  logger.error('[xhs-inpage-signer] 30 秒内未找到可用的签名窗口');
  return null;
}

/**
 * 在签名窗口上下文执行表达式。
 * 优先复用主进程内窗口（webContents.debugger，无需 9222 端口，打包版稳定）；
 * 进程内匹配不到时回退到 9222 远程通道（开发态兼容）。
 */
async function evaluateInSigner(expression: string): Promise<any> {
  await ensureSignerWindow();
  const matchXhsPage = (url: string) =>
    url.includes('xiaohongshu.com') || url === '' || url === 'about:blank';
  const deadline = Date.now() + 30000;
  let navigatedBlankLocal = false;
  while (Date.now() < deadline) {
    const win = findLocalPage(matchXhsPage);
    if (win) {
      const value = await withLocalCdp(matchXhsPage, async (cdp) => {
        try {
          const url = win.webContents.getURL();
          // 空白/未加载的窗口：主动导航到小红书首页，避免永远等不到签名函数
          if ((url === '' || url === 'about:blank') && !navigatedBlankLocal) {
            navigatedBlankLocal = true;
            await cdp.send('Page.navigate', { url: SIGNER_URL }).catch(() => {});
            await new Promise((s) => setTimeout(s, 2000));
          }
          const r = await cdp.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          return r?.result?.value;
        } finally {
          cdp.close();
        }
      });
      if (value !== null) {
        if (value === 'NOT_READY') {
          await new Promise((s) => setTimeout(s, 1000));
          continue;
        }
        return value;
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  logger.warn('[xhs-inpage-signer] 进程内窗口签名未就绪，回退 9222 远程通道');
  return evaluateInSignerViaRemote(expression);
}

export interface XhsSignature { 'X-s': string; 'X-t': string }

/**
 * 页面内签名：url 为接口路径（含 query），data 为 POST body（GET 传空）。
 * ua 必须与发起请求的 User-Agent 完全一致（签名与 UA 绑定，不一致会 406）；
 * a1 为账号 a1 cookie 值（签名与 a1 绑定，先注入签名窗口会话）。
 */
export async function signInPage(url: string, data: any, ua: string, a1?: string): Promise<XhsSignature | null> {
  try {
    // a1 绑定：签名算法从页面 document.cookie 读取 a1，先把账号 a1 注入签名窗口会话
    if (a1) {
      const { session } = await import('electron');
      const ses = session.fromPartition(PLAT_PARTITION);
      await ses.cookies.set({ url: 'https://www.xiaohongshu.com', name: 'a1', value: a1 }).catch(() => {});
      await ses.cookies.flushStore().catch(() => {});
    }
    const dataStr = data ? JSON.stringify(data) : '';
    const expr = '(async () => {\n'
      + '  try {\n'
      + '    if (typeof window._webmsxyw !== \'function\') return \'NOT_READY\';\n'
      + '    const res = window._webmsxyw(' + JSON.stringify(url) + ', ' + JSON.stringify(dataStr) + ', ' + JSON.stringify(ua) + ');\n'
      + '    return JSON.stringify(res);\n'
      + '  } catch (e) { return \'SIGN_ERR \' + String(e).slice(0, 80); }\n'
      + '})()';
    const result = await evaluateInSigner(expr);
    if (result === 'NOT_READY') {
      logger.warn('[xhs-inpage-signer] 签名函数长时间未就绪');
      return null;
    }
    if (typeof result === 'string' && result.startsWith('SIGN_ERR')) {
      logger.error('[xhs-inpage-signer] 签名失败:', result);
      return null;
    }
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    if (parsed && parsed['X-s'] && parsed['X-t']) {
      return { 'X-s': parsed['X-s'], 'X-t': parsed['X-t'] };
    }
    logger.error('[xhs-inpage-signer] 签名结果格式异常:', typeof result === 'string' ? result.slice(0, 120) : result);
    return null;
  } catch (e) {
    logger.error('[xhs-inpage-signer] 签名异常:', e);
    return null;
  }
}
