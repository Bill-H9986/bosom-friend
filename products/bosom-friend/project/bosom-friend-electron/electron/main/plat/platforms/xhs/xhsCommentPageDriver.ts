/**
 * 小红书评论自动接待 · www 官方笔记页驱动（与私信同款思路）
 *
 * 为什么走 www 而不走创作者中心/API：
 * - 评论 API 对个人账号被风控（300011 Account abnormal）；
 * - 创作者平台新版已移除桌面端评论管理；
 * - www.xiaohongshu.com 官方笔记页（带 xsec_token）可正常展示评论并提供回复 UI，
 *   签名由官方前端维护，无第三方依赖（与私信发送器 xhsImSender 同原理）。
 */
import { BrowserWindow } from 'electron';
import { logger } from '../../../../global/log';

const PLAT_PARTITION = 'persist:zhiyin-xhs';
const EXPLORE_URL = 'https://www.xiaohongshu.com/explore';
const XSEC_SOURCE = 'pc_user';

let commentWindow: BrowserWindow | null = null;

function ensureCommentWindow(): BrowserWindow {
  if (commentWindow && !commentWindow.isDestroyed())
    return commentWindow;
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
  win.webContents.setBackgroundThrottling(false);
  void win.loadURL(EXPLORE_URL).catch((e) => {
    logger.warn('[xhs-comment-driver] 窗口加载失败:', e);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.warn('[xhs-comment-driver] 窗口渲染进程退出，稍后重建:', details.reason);
    if (commentWindow === win)
      commentWindow = null;
    if (!win.isDestroyed())
      win.destroy();
    setTimeout(() => {
      try {
        ensureCommentWindow();
      }
      catch (e) {
        logger.error('[xhs-comment-driver] 重建窗口失败:', e);
      }
    }, 8000);
  });
  win.on('closed', () => {
    if (commentWindow === win)
      commentWindow = null;
  });
  commentWindow = win;
  return win;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withCommentWindow<T>(
  fn: (cdp: Electron.Debugger, win: BrowserWindow) => Promise<T>,
): Promise<T> {
  let win = ensureCommentWindow();
  await sleep(3000);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (win.isDestroyed()) {
        commentWindow = null;
        win = ensureCommentWindow();
        await sleep(4000);
      }
      if (!win.webContents.debugger.isAttached())
        win.webContents.debugger.attach('1.3');
      return await fn(win.webContents.debugger, win);
    }
    catch (e) {
      lastError = e;
      try {
        win.webContents.debugger.detach();
      }
      catch {
        // 已断开无需处理
      }
      // 目标不可用：销毁并重建窗口后重试一次（渲染进程崩溃/页面正在导航等瞬态情况自愈）
      if (attempt === 0 && /No target|Target is rejected|not attached|Cannot access/.test(String((e as Error)?.message ?? e))) {
        try {
          win.destroy();
        }
        catch {
          // 已销毁
        }
        commentWindow = null;
        win = ensureCommentWindow();
        await sleep(4000);
        continue;
      }
      throw e;
    }
    finally {
      try {
        win.webContents.debugger.detach();
      }
      catch {
        // 已断开无需处理
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function evalIn(
  cdp: Electron.Debugger,
  expression: string,
): Promise<unknown> {
  const r = (await cdp.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
  if (r?.exceptionDetails)
    throw new Error(r.exceptionDetails.text || '页面脚本异常');
  return r?.result?.value;
}

export interface XhsCommentItem {
  commentId: string;
  noteId: string;
  content: string;
  nickname: string;
}

interface NoteToken {
  noteId: string;
  xsecToken: string;
}

let profileCacheAt = 0;
let profileCache: { userId: string; notes: NoteToken[] } | null = null;
const PROFILE_CACHE_TTL = 10 * 60 * 1000;

/** 从已登录主页读取自己的用户 ID 与笔记 ID 列表（带 10 分钟缓存） */
async function getOwnNotes(cdp: Electron.Debugger): Promise<{ userId: string; noteIds: string[] }> {
  if (profileCache && Date.now() - profileCacheAt < PROFILE_CACHE_TTL)
    return { userId: profileCache.userId, noteIds: profileCache.notes.map((n) => n.noteId) };
  await cdp.sendCommand('Page.navigate', { url: EXPLORE_URL });
  await sleep(7000);
  const meHref = (await evalIn(
    cdp,
    `(() => { const a = Array.from(document.querySelectorAll('a')).find(x => (x.innerText||'').trim()==='我' && /user\\/profile\\//.test(x.href)); return a ? a.href : ''; })()`,
  )) as string;
  if (!meHref)
    throw new Error('www 小红书未登录或未找到个人主页入口');
  await cdp.sendCommand('Page.navigate', { url: meHref });
  const noteIds: string[] = [];
  const tokens = new Map<string, string>();
  // SSR HTML 内嵌 token 链接：/user/profile/<uid>/<noteId>?xsec_token=…&amp;xsec_source=pc_user
  for (let attempt = 0; attempt < 4 && noteIds.length === 0; attempt++) {
    await sleep(5000);
    const html = (await evalIn(cdp, `document.documentElement.outerHTML`)) as string;
    const re = /\/user\/profile\/[0-9a-f]+\/([0-9a-f]{24})\?xsec_token=([A-Za-z0-9_=-]+)&amp;xsec_source=pc_user/g;
    for (const m of html.matchAll(re)) {
      if (!noteIds.includes(m[1]))
        noteIds.push(m[1]);
      tokens.set(m[1], m[2]);
    }
  }
  const userId = meHref.match(/profile\/([0-9a-f]+)/)?.[1] ?? '';
  profileCache = { userId, notes: noteIds.map((noteId) => ({ noteId, xsecToken: tokens.get(noteId) ?? '' })) };
  profileCacheAt = Date.now();
  logger.info('[xhs-comment-driver] 主页笔记列表已缓存：' + noteIds.length + ' 条');
  return { userId, noteIds };
}

function noteUrl(userId: string, note: NoteToken): string {
  return `https://www.xiaohongshu.com/user/profile/${userId}/${note.noteId}?xsec_token=${encodeURIComponent(note.xsecToken)}&xsec_source=pc_user`;
}

function isCommentListUrl(url: string): boolean {
  return /comment/i.test(url) && url.includes('edith.xiaohongshu.com');
}

/** 从评论接口响应识别评论（含子评论作者回复标记） */
function extractComments(json: unknown, noteId: string, selfUid: string): XhsCommentItem[] {
  const data = json as {
    data?: { comments?: any[]; sub_comments?: any[] };
    comments?: any[];
  };
  const list = data?.data?.comments ?? data?.data?.sub_comments ?? data?.comments;
  if (!Array.isArray(list))
    return [];
  const items: XhsCommentItem[] = [];
  for (const c of list) {
    const commentId = String(c?.id ?? c?.comment_id ?? '');
    const content = String(c?.content ?? '');
    const nickname = String(c?.user_info?.nickname ?? c?.user?.nickname ?? '');
    const subs = Array.isArray(c?.sub_comments) ? c.sub_comments : [];
    const selfReplied = subs.some(
      (s: any) => String(s?.user_info?.user_id ?? s?.user_id ?? '') === selfUid,
    );
    if (!commentId || !content || selfReplied)
      continue;
    items.push({ commentId, noteId, content, nickname });
  }
  return items;
}

let inflightRead: Promise<XhsCommentItem[]> | null = null;
let readCacheAt = 0;
let readCache: XhsCommentItem[] = [];
const READ_CACHE_TTL = 20 * 1000;

/** 逐条打开自己的笔记页，拦截评论接口读取全部未回复评论 */
export async function collectXhsComments(): Promise<XhsCommentItem[]> {
  if (Date.now() - readCacheAt < READ_CACHE_TTL)
    return readCache;
  if (inflightRead)
    return inflightRead;
  inflightRead = readOnce().finally(() => {
    inflightRead = null;
  });
  const items = await inflightRead;
  readCacheAt = Date.now();
  readCache = items;
  return items;
}

async function readOnce(): Promise<XhsCommentItem[]> {
  return withCommentWindow(async (cdp) => {
    const own = await getOwnNotes(cdp);
    if (own.noteIds.length === 0) {
      logger.info('[xhs-comment-driver] 未读取到自己的笔记');
      return [];
    }
    const byId = new Map<string, XhsCommentItem>();
    for (const note of profileCache?.notes.slice(0, 10) ?? []) {
      if (!note.xsecToken)
        continue;
      await cdp.sendCommand('Page.navigate', { url: noteUrl(own.userId, note) });
      await sleep(4000);
      // 滚动两次触发评论区懒加载
      await evalIn(cdp, `window.scrollTo(0, document.body.scrollHeight); 'ok'`);
      await sleep(2000);
      await evalIn(cdp, `window.scrollTo(0, document.body.scrollHeight); 'ok'`);
      await sleep(2000);
      const raw = (await evalIn(
        cdp,
        `JSON.stringify(Array.from(document.querySelectorAll('.comment-item')).map(el => {
          const lines = (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
          const author = lines[0] || '';
          const isAuthorSub = lines[1] === '作者';
          const timeIdx = lines.findIndex(l => /^\\d|天前|昨天|周/.test(l) && l.length < 24);
          const content = lines.slice(1, timeIdx > 1 ? timeIdx : 2).join(' ').trim();
          return { author, content, isAuthorSub };
        }).filter(x => x.content && !x.isAuthorSub))`,
      )) as string;
      const rows = JSON.parse(raw || '[]') as Array<{ author: string; content: string }>;
      logger.info('[xhs-comment-driver] 笔记 ' + note.noteId + ' DOM 读取评论 ' + rows.length + ' 条');
      for (const row of rows) {
        const commentId = `${note.noteId}:${row.author}:${row.content}`;
        byId.set(commentId, {
          commentId,
          noteId: note.noteId,
          content: row.content,
          nickname: row.author,
        });
      }
    }
    const items = Array.from(byId.values());
    logger.info('[xhs-comment-driver] www 官方页读取评论完成：' + items.length + ' 条');
    return items;
  }).catch((e) => {
    logger.error('[xhs-comment-driver] 读取评论失败:', e);
    return [] as XhsCommentItem[];
  });
}

/** www 笔记页 DOM 回复：定位评论 → 点回复 → 输入 → 发送 */
export async function replyXhsComment(
  noteId: string,
  commentText: string,
  reply: string,
): Promise<{ ok: boolean; message?: string }> {
  return withCommentWindow(async (cdp) => {
    const own = await getOwnNotes(cdp);
    const note = profileCache?.notes.find((n) => n.noteId === noteId);
    if (!note?.xsecToken)
      return { ok: false, message: '主页笔记列表中未找到该笔记' };
    await cdp.sendCommand('Page.navigate', { url: noteUrl(own.userId, note) });
    await sleep(4000);
    await evalIn(cdp, `window.scrollTo(0, document.body.scrollHeight); 'ok'`);
    await sleep(2000);
    const result = (await evalIn(cdp, domReplyScript(commentText, reply))) as {
      ok?: boolean;
      error?: string;
      detail?: string;
    };
    if (!result?.ok)
      return { ok: false, message: result?.error || '页面回复操作失败' };
    logger.info('[xhs-comment-driver] www 官方页评论回复已提交:', result.detail || '');
    return { ok: true, message: result.detail };
  }).catch((e) => {
    logger.error('[xhs-comment-driver] 评论回复异常:', e);
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  });
}

function domReplyScript(commentText: string, reply: string): string {
  return `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const text = ${JSON.stringify(commentText)};
    const reply = ${JSON.stringify(reply)};
    const row = Array.from(document.querySelectorAll('.comment-item')).find(el => (el.innerText || '').includes(text));
    if (!row) return { ok: false, error: '未找到目标评论' };
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(300);
    const btn = row.querySelector('.reply') || Array.from(row.querySelectorAll('*')).find(e => e.children.length === 0 && (e.innerText || '').trim() === '回复');
    if (!btn) return { ok: false, error: '评论内未找到回复按钮' };
    btn.click();
    await sleep(800);
    const input = document.querySelector('p.content-input') || document.querySelector('[contenteditable="true"]') || document.querySelector('textarea') || document.querySelector('input[type="text"]');
    if (!input) return { ok: false, error: '未找到回复输入框' };
    input.focus();
    // execCommand 会把文本真实写进编辑器 DOM（textContent + 合成 input 事件不被框架识别）
    document.execCommand('insertText', false, reply);
    await sleep(400);
    // 框架的启用态可能不同步（按钮仍灰），提交时平台读 DOM 文本，强制启用后点击即可
    const send = document.querySelector('button.btn.submit')
      || Array.from(document.querySelectorAll('button')).find(e => /^(发送|发布)$/.test((e.innerText || '').trim()));
    if (send) {
      if (send.disabled) send.disabled = false;
      send.click();
      await sleep(800);
      return { ok: true, detail: '已点击发送' };
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(800);
    return { ok: true, detail: '已回车提交' };
  })()`;
}
