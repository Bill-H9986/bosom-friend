/*
 * 评论页面驱动（抖音创作者中心 · 评论管理页）
 *
 * 背景：抖音已升级创作者评论接口签名（新版 a_bogus），API 直连会被拒绝。
 * 本驱动复用已登录抖音窗口（CDP 9222），在页面内模拟真实用户操作，由页面自身生成签名：
 *   定位目标评论 → 点击“回复” → 回复输入框输入 → 点击“发送” → 确认成功
 *
 * 踩坑记录（重要，勿回退）：
 * 旧实现直接往页面顶部“有爱评论，说点好听的~”全局输入框输入并点发送，
 * 那其实是“发布作品评论”而非“回复某条评论”，自动化时发送按钮也不可用。
 * 正确做法参考竞品 douyin-creator-tools：先点击评论行的“回复”按钮，
 * 会展开专属回复输入框（placeholder 以“回复 xxx：”开头），输入后其“发送”按钮才启用。
 */

// 复用当前 Electron 进程的调试端口（主窗口 remote-debugging-port=9222）。
// 抖音创作者后台以 webview 形态存在，type 可能为 page 或 webview，按 URL 匹配即可。
const CDP_BASE = 'http://127.0.0.1:9222';
const MESSAGES_URL_PATTERN = '*www.douyin.com/messages*';
const COMMENT_PAGE = (itemId: string) =>
  `https://creator.douyin.com/creator-micro/interactive/comment?item_id=${itemId}&enter_from=content_manage_v2`;
import { logger } from '../../global/log'
import { SimpleWebSocket } from '../safety/wsClient';

interface CdpPage {
  webSocketDebuggerUrl: string;
}

interface CdpSession {
  send: (method: string, params?: any) => Promise<any>;
  close: () => void;
  ws: any;
}

export interface CommentReplyPlan {
  commentId: string;
  /** 评论者昵称（页面定位辅助，可空） */
  username?: string;
  /** 评论内容（页面定位主依据） */
  commentText: string;
  /** AI 生成的回复文案 */
  reply: string;
}

export type CommentReplyStatus =
  | 'replied'
  | 'sent_unconfirmed'
  | 'already_replied'
  | 'comment_not_found'
  | 'reply_open_failed'
  | 'send_failed'
  | 'error';

export interface CommentReplyResult {
  commentId: string;
  ok: boolean;
  status: CommentReplyStatus;
  message?: string;
}

/** 页面读取到的评论行 */
export interface PageCommentItem {
  /** 抖音评论唯一 ID（从 React fiber 提取，用于精准去重） */
  cid?: string;
  /** 评论发布时间（Unix 秒） */
  createTime?: number;
  /** 去重 key：作品ID + 评论文本指纹（页面不暴露稳定评论ID） */
  key: string;
  /** 评论者昵称（可为空） */
  username?: string;
  /** 评论文本（与页面显示一致，用于页面内定位回复） */
  commentText: string;
  /** 该评论是否已有回复 */
  hasReply: boolean;
}

/** 提取页面评论行：昵称 + 时间 + 正文 + 操作（兼容抖音新旧两版评论管理页） */
const EXTRACT_COMMENTS_EXPR = `(() => {
  const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
  // 新版评论时间是“没有发布于前缀”的绝对时间；旧版是相对时间（N分钟前/刚刚）
  const TIME_RE = /(发布于\\d{4}年\\d{1,2}月\\d{1,2}日(?:\\s+\\d{1,2}:\\d{2})?|\\d{4}年\\d{1,2}月\\d{1,2}日(?:\\s+\\d{1,2}:\\d{2})?|\\d+分钟前|\\d+小时前|\\d+天前|刚刚)/;
  const out = [];
  const seen = new Set();
  const rows = [];
  for (const el of document.querySelectorAll('div, li')) {
    if (!(el instanceof HTMLElement) || el.offsetParent === null) continue;
    const t = norm(el.textContent || '');
    if (!t || t.length < 10 || t.length > 1500) continue;
    // 评论行判据：含时间标记 + 操作区；作品卡只有“发布于”没有回复/删除/举报
    if (!TIME_RE.test(t) || !/(回复|删除|举报)/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    rows.push(el);
  }
  // 只保留最小评论行，去掉包含其它行的父容器
  const picked = rows.filter((el) => !rows.some((o) => o !== el && o.contains(el)));
  for (const row of picked) {
    const t = norm(row.textContent || '');
    const hasReply = /(查看\\d+条回复|收起)/.test(t);
    let clean = t.replace(/\\s*(?:查看\\d+条回复|收起|没有更多评论|暂无更多评论|点击刷新)\\s*$/, '');
    const tm = clean.match(TIME_RE);
    if (!tm || typeof tm.index !== 'number') continue;
    const username = clean.slice(0, tm.index).replace(/作者$/, '').trim().slice(-40);
    let rest = clean.slice(tm.index + tm[0].length).trim();
    // 去掉尾部“点赞数 + 回复 删除 举报”操作区
    rest = rest.replace(/\\s*\\d*\\s*(?:回复\\s*删除\\s*举报|删除\\s*举报|回复\\s*删除|回复\\s*举报|回复|删除|举报)\\s*$/, '').trim();
    if (!rest) continue;
    out.push({ username, commentText: rest.slice(0, 2000), hasReply });
  }
  return JSON.stringify(out);
})()`;

/**
 * 以页面为唯一数据源：打开作品评论管理页，读取全部未回复评论。
 * 背景：web 评论 API 与创作者后台页面数据源不一致（API 可能返回页面不存在的评论、
 * 漏掉页面展示的评论），评论自动回复必须以页面展示为准，才能保证页面内定位成功。
 */
export async function collectPageComments(
  awemeId: string,
  workTitle: string,
  createTime?: string,
): Promise<{ ok: boolean; comments: PageCommentItem[]; message?: string }> {
  let page = await findDouyinPage();
  if (!page) {
    page = await findAnyDouyinPage();
    if (!page) {
      logger.info('[comment-page-driver] 未找到已登录的抖音窗口（9222）');
      return { ok: false, comments: [], message: '未找到已登录的抖音窗口（9222）' };
    }
  }

  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
    await enableMessagesGuard(cdp);
    const currentUrl = (await evalValue<string>(cdp, 'location.href')) || '';
    const needNavigate =
      !currentUrl.includes('/interactive/comment') ||
      !currentUrl.includes(`item_id=${awemeId}`);
    if (needNavigate) {
      await cdp.send('Page.navigate', { url: COMMENT_PAGE(awemeId) });
      await sleep(4000);
    }

    // 评论管理页必须通过"选择作品"侧边栏切换作品（URL item_id 参数不会触发数据刷新）。
    // 因此导航后总是执行一次侧边栏选中，确保读取的是目标作品的评论。
    const ready = await waitFor(cdp, READY_EXPR, 15000, 500);
    if (!ready) {
      return { ok: false, comments: [], message: '评论管理页加载超时' };
    }
    const selected = await selectWorkViaSideSheet(cdp, awemeId, workTitle, createTime);
    if (!selected) {
      return { ok: false, comments: [], message: '侧边栏切换作品失败' };
    }

    // 滚动加载全部评论（最多 10 次），再提取
    for (let i = 0; i < 10; i++) {
      const before = await evalValue<number>(
        cdp,
        `document.querySelectorAll('.container-sXKyMs').length`,
      );
      await evalValue(cdp, SCROLL_MORE_EXPR);
      await sleep(randomRange(1500, 2500));
      const after = await evalValue<number>(
        cdp,
        `document.querySelectorAll('.container-sXKyMs').length`,
      );
      if (after === before) break;
    }

    const raw = await evalValue<string>(cdp, EXTRACT_COMMENTS_EXPR);
    let rows: {
      username: string;
      commentText: string;
      hasReply: boolean;
      cid?: string | null;
      createTime?: number | null;
    }[] = [];
    try {
      rows = raw ? JSON.parse(raw) : [];
    } catch {
      rows = [];
    }

    const comments: PageCommentItem[] = rows
      .filter((r) => !r.hasReply && r.commentText)
      .map((r) => ({
        // 去重 key 优先用抖音评论唯一 ID（cid），避免相同文本的新评论被误判为已回复；
        // 拿不到 cid 时退化为评论文本
        cid: r.cid || undefined,
        createTime: r.createTime || undefined,
        key: r.cid ? `cid:${r.cid}` : r.commentText,
        username: r.username || undefined,
        commentText: r.commentText,
        hasReply: false,
      }));
    logger.info(
      '[comment-page-driver] 页面读取评论，共',
      rows.length,
      '条，未回复',
      comments.length,
      '条，作品',
      awemeId,
    );
    return { ok: true, comments };
  } catch (e) {
    return {
      ok: false,
      comments: [],
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    cdp.close();
  }
}

function connect(wsUrl: string) {
  return new Promise<CdpSession>(async (resolve, reject) => {
    // CDP 连接/握手必须超时，否则轮询会永久挂起导致整条链路停摆
    const timeoutMs = 15000;
    const timer = setTimeout(() => {
      reject(new Error('CDP 连接超时: ' + wsUrl));
    }, timeoutMs);
    try {
      const ws = await SimpleWebSocket.connect(wsUrl);
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
          new Promise((res, rej) => {
            const mid = ++id;
            // CDP 命令超时，防止页面卡死导致 send 永不返回
            const cmdTimer = setTimeout(() => {
              pending.delete(mid);
              rej(new Error('CDP 命令超时: ' + method));
            }, 10000);
            pending.set(mid, (v) => {
              clearTimeout(cmdTimer);
              res(v);
            });
            ws.send({ id: mid, method, params });
          }),
        close: () => ws.close(),
        ws,
      });
    } catch (e) {
      reject(e);
    } finally {
      clearTimeout(timer);
    }
  });
}

/**
 * 204 守卫：拦截一切到 www.douyin.com/messages 的导航并返回 204。
 * 抖音创作者页面加载约 4 秒后会被 JS 强制跳转到 /messages（对部分账号 404），
 * 不拦截会导致评论页/私信页被跳走。
 */
async function enableMessagesGuard(cdp: CdpSession): Promise<void> {
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: MESSAGES_URL_PATTERN, requestStage: 'Request' }],
  });
  cdp.ws.onMessage((msg: any) => {
    if (msg.method === 'Fetch.requestPaused') {
      const p = msg.params;
      if (/douyin\.com\/messages/.test(p.request.url)) {
        void cdp.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 204,
          responseHeaders: [],
        });
      } else {
        void cdp.send('Fetch.continueRequest', { requestId: p.requestId });
      }
    }
  });
}

async function findDouyinPage(): Promise<CdpPage | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    let list: { type: string; url: string; webSocketDebuggerUrl: string }[];
    try {
      list = (await fetch(CDP_BASE + '/json/list', { signal: controller.signal }).then((r) => r.json())) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];
    } finally {
      clearTimeout(t);
    }
    // 优先独立自动化窗口（type=page），其次前端 webview（type=webview）；
    // 排除私信聊天页（/data/following/chat）与重新授权扫码窗口（zhiyin_relogin=1）
    return (
      list.find(
        (t) =>
          t.type === 'page' &&
          t.url.includes('creator.douyin.com') &&
          !t.url.includes('/data/following/chat') &&
          !t.url.includes('/content/upload') &&
          !t.url.includes('/content/post/') &&
          !t.url.includes('zhiyin_relogin=1'),
      ) ||
      list.find(
        (t) =>
          t.url.includes('creator.douyin.com') &&
          !t.url.includes('/data/following/chat') &&
          !t.url.includes('/content/upload') &&
          !t.url.includes('/content/post/') &&
          !t.url.includes('zhiyin_relogin=1'),
      ) ||
      null
    );
  } catch {
    return null;
  }
}

async function findAnyDouyinPage(): Promise<CdpPage | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    let list: { type: string; url: string; webSocketDebuggerUrl: string }[];
    try {
      list = (await fetch(CDP_BASE + '/json/list', { signal: controller.signal }).then((r) => r.json())) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];
    } finally {
      clearTimeout(t);
    }
    return (
      list.find(
        (t) =>
          /(creator|www)\.douyin\.com/.test(t.url) &&
          !t.url.includes('/content/upload') &&
          !t.url.includes('/content/post/') &&
          !t.url.includes('zhiyin_relogin=1'),
      ) || null
    );
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomRange = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min));

/** 将回复文本按码点切块，模拟真实打字节奏（防止一次性大段输入被风控） */
function splitText(text: string): string[] {
  const chars = [...text];
  const chunk = 18;
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += chunk) {
    out.push(chars.slice(i, i + chunk).join(''));
  }
  return out.length ? out : [''];
}

async function evalValue<T>(cdp: CdpSession, expression: string): Promise<T | undefined> {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return r?.result?.value as T | undefined;
}

async function waitFor(
  cdp: CdpSession,
  expression: string,
  timeoutMs: number,
  intervalMs = 300,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evalValue<boolean>(cdp, expression)) return true;
    } catch {
      // 页面刷新等瞬时错误忽略，继续轮询
    }
    await sleep(intervalMs);
  }
  return false;
}

async function waitForValue(
  cdp: CdpSession,
  expression: string,
  timeoutMs: number,
  intervalMs = 300,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await evalValue<string>(cdp, expression);
      if (v) return v;
    } catch {
      // ignore
    }
    await sleep(intervalMs);
  }
  return null;
}

const REPLY_INPUT_FINDER = `[...document.querySelectorAll('[contenteditable="true"]')]
  .find(el => el instanceof HTMLElement && el.offsetParent !== null && (el.getAttribute('placeholder') || '').startsWith('回复'))`;

/** 将回复输入框滚动到可视区域中央并返回是否就绪 */
const SCROLL_REPLY_INPUT_INTO_VIEW_EXPR = `(() => {
  const el = (${REPLY_INPUT_FINDER});
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  return true;
})()`;

/** JS 聚焦回复输入框（实测本页面鼠标点击会被遮挡层吞掉，JS focus 稳定可靠） */
const FOCUS_REPLY_INPUT_EXPR = `(() => {
  const el = (${REPLY_INPUT_FINDER});
  if (!el) return false;
  el.focus();
  return true;
})()`;

const REPLY_INPUT_FOCUSED_EXPR = `(() => {
  const el = document.activeElement;
  return !!el && (el.isContentEditable || el.getAttribute('contenteditable') === 'true');
})()`;

const REPLY_INPUT_READY_EXPR = `(() => { return !!(${REPLY_INPUT_FINDER}); })()`;

/** 评论列表就绪：兼容新旧两版（旧版操作行/“全部评论”下拉，新版“选择作品”按钮与列表容器） */
const READY_EXPR = `(() => {
  if (document.querySelectorAll('.operations-WFV7Am').length > 0) return true;
  const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
  if ([...document.querySelectorAll('button')].some(el => norm(el.textContent || '') === '选择作品')) return true;
  if (document.querySelector('.douyin-creator-interactive-tabs-pane-active, .empty-refresh-Mt1Apg, .loading-CwwynV')) return true;
  return [...document.querySelectorAll('[role="combobox"]')]
    .some(el => /(全部评论|最新发布)/.test(norm(el.textContent || '')));
})()`;

/** 定位目标评论：按评论内容精确/前缀匹配，可附加昵称过滤；命中后给操作行打标记 */
function buildFindCommentExpr(plan: CommentReplyPlan, withUsername: boolean): string {
  const wanted = plan.commentText.replace(/\s+/g, ' ').trim().slice(0, 80);
  const wantedUser = (withUsername ? plan.username || '' : '').replace(/\s+/g, ' ').trim();
  return `(() => {
    const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
    const wanted = ${JSON.stringify(wanted)};
    const wantedUser = ${JSON.stringify(wantedUser)};
    for (const el of document.querySelectorAll('[data-zhiyin-comment]')) el.removeAttribute('data-zhiyin-comment');
    const leaves = [...document.querySelectorAll('div,span,p')]
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    const exact = [];
    const prefix = [];
    for (const leaf of leaves) {
      const t = norm(leaf.textContent || '');
      if (!t || t.length > 300) continue;
      if (t === wanted) exact.push(leaf);
      else if (t.length > wanted.length && t.startsWith(wanted) && wanted.length >= 6) prefix.push(leaf);
    }
    const tryMatch = (candidate) => {
      let row = candidate;
      for (let i = 0; i < 10 && row; i++) {
        const rowText = norm(row.textContent || '');
        // 评论行判据：含时间标记与操作区；作品卡只有“发布于”没有回复/删除/举报，不会命中
        if (
          rowText.length > 0
          && rowText.length < 1500
          && /(\\d{4}年|分钟前|小时前|天前|刚刚)/.test(rowText)
          && /(回复|删除|举报)/.test(rowText)
        ) {
          const rect = row.getBoundingClientRect();
          if (rect.width >= 240) {
            if (wantedUser && !rowText.includes(wantedUser)) return null;
            row.setAttribute('data-zhiyin-comment', '1');
            return row;
          }
        }
        row = row.parentElement;
      }
      return null;
    };
    for (const c of exact) { if (tryMatch(c)) return 'ok'; }
    for (const c of prefix) { if (tryMatch(c)) return 'ok'; }
    return null;
  })()`;
}

/** 滚动加载更多评论：优先滚动主滚动容器，找不到再退化为滚动最大的可滚动 div */
const SCROLL_MORE_EXPR = `(() => {
  const tryScroll = (el) => {
    if (!el) return false;
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    return el.scrollTop !== before;
  };
  if (tryScroll(document.scrollingElement)) return 'ok';
  if (tryScroll(document.body)) return 'ok';
  let best = null;
  for (const el of document.querySelectorAll('div')) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 200) {
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
  }
  if (best) { best.scrollTop = best.scrollHeight; return 'ok'; }
  return null;
})()`;

/** 评论是否已有回复（查看N条回复 / 收起） */
const ALREADY_REPLIED_EXPR = `(() => {
  const row = document.querySelector('[data-zhiyin-comment="1"]');
  if (!row) return 'no_marker';
  const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
  const t = norm(row.textContent || '');
  if (/(?:查看|展开)?(?:全部)?[1-9]\\d*条回复/.test(t) || t.includes('收起')) return 'replied';
  return 'open';
})()`;

/** 点击目标评论的“回复”按钮 */
const CLICK_REPLY_EXPR = `(() => {
  const row = document.querySelector('[data-zhiyin-comment="1"]');
  if (!row) return null;
  const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
  const cands = [...row.querySelectorAll('*')]
    .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
  // 新版“回复”挂在 div.item-M3fSkJ 上（内含图标子节点），按文本精确匹配并取最内层
  let btn = cands
    .filter(el => norm(el.textContent || '') === '回复' && el.children.length <= 2)
    .sort((a, b) => a.children.length - b.children.length)[0];
  if (!btn) {
    btn = cands.find(el => el.children.length === 0 && norm(el.textContent || '') === '回复');
  }
  if (!btn) return null;
  btn.click();
  return 'ok';
})()`;

/** 回复发送按钮状态：从回复输入框向上找“发送”按钮；页面级评论发送按钮永远禁用，必须跳过禁用项 */
const REPLY_SEND_STATE_EXPR = `(() => {
  const input = (${REPLY_INPUT_FINDER});
  if (!input) return null;
  const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
  let n = input;
  for (let i = 0; i < 6 && n; i++) {
    const btns = [...n.querySelectorAll('button')]
      .filter(b => norm(b.textContent || '') === '发送');
    if (btns.length) {
      const enabled = btns.find(b => !(
        b.disabled
        || b.getAttribute('disabled') !== null
        || b.getAttribute('aria-disabled') === 'true'
      ));
      if (enabled) return 'ok';
      // 本层是禁用的页面级发送按钮，继续向外找回复专属发送按钮
      n = n.parentElement;
      continue;
    }
    n = n.parentElement;
  }
  return null;
})()`;

/**
 * 点击回复发送按钮（JS 原生 click，实测比鼠标坐标点击更可靠：
 * 鼠标坐标点击存在命中/遮挡问题导致偶发不触发，JS click 稳定触发 React 提交并收到“回复成功”）
 */
const CLICK_REPLY_SEND_EXPR = `(() => {
  const input = (${REPLY_INPUT_FINDER});
  if (!input) return null;
  const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
  let n = input;
  for (let i = 0; i < 6 && n; i++) {
    const btns = [...n.querySelectorAll('button')]
      .filter(b => norm(b.textContent || '') === '发送');
    if (btns.length) {
      const enabled = btns.find(b => !(
        b.disabled
        || b.getAttribute('disabled') !== null
        || b.getAttribute('aria-disabled') === 'true'
      ));
      if (enabled) {
        enabled.click();
        return 'ok';
      }
      n = n.parentElement;
      continue;
    }
    n = n.parentElement;
  }
  return null;
})()`;

/** 发送确认：输入框已清空 / 出现成功提示 / 评论行出现回复线程 */
const REPLY_CONFIRM_EXPR = `(() => {
  const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
  const input = (${REPLY_INPUT_FINDER});
  if (input) {
    const t = norm(input.textContent || '');
    if (!t) return 'input_cleared';
  }
  const toast = [...document.querySelectorAll('[role="alert"], div, span')]
    .filter(el => el instanceof HTMLElement && el.offsetParent !== null)
    .map(el => norm(el.textContent || ''))
    .some(t => t.includes('回复成功') || t.includes('发送成功'));
  if (toast) return 'toast';
  const ops = document.querySelector('[data-zhiyin-comment="1"]');
  if (ops) {
    let row = ops;
    for (let i = 0; i < 3 && row; i++) {
      const t = norm(row.textContent || '');
      if (/(?:查看|展开)?(?:全部)?[1-9]\\d*条回复/.test(t) || t.includes('收起')) return 'thread';
      row = row.parentElement;
    }
  }
  return null;
})()`;

/** 兜底：评论列表未加载时，通过“选择作品”侧边栏选中目标作品（参考竞品 douyin-creator-tools） */
async function selectWorkViaSideSheet(
  cdp: CdpSession,
  awemeId: string,
  workTitle: string,
  createTime?: string,
): Promise<boolean> {
  const clicked = await evalValue<string>(cdp, `(() => {
    const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
    const btn = [...document.querySelectorAll('button')]
      .find(el => el instanceof HTMLElement && el.offsetParent !== null && norm(el.textContent || '') === '选择作品');
    if (!btn) return null;
    btn.click();
    return 'ok';
  })()`);
  if (clicked !== 'ok') return false;
  const sheetReady = await waitFor(
    cdp,
    `(() => {
      const sheet = [...document.querySelectorAll('.douyin-creator-interactive-sidesheet-body')]
        .find(el => el instanceof HTMLElement && el.offsetParent !== null);
      return !!sheet;
    })()`,
    10000,
    400,
  );
  if (!sheetReady) return false;
  const title = (workTitle || '').replace(/\s+/g, '').slice(0, 15);
  const time = (createTime || '').replace(/\s+/g, '');
  const picked = await evalValue<string>(cdp, `(() => {
    const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
    const compact = (s = '') => norm(s).replace(/\\s+/g, '');
    const wantedTime = ${JSON.stringify(time)};
    const wanted = ${JSON.stringify(title)};
    const cards = [...document.querySelectorAll('.douyin-creator-interactive-sidesheet-body *')]
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null)
      .filter(el => {
        const t = compact(el.textContent || '');
        return t.includes('发布于') && (wantedTime ? t.includes(wantedTime) : wanted ? t.includes(wanted) : true);
      })
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    const card = cards[0];
    if (!card) return null;
    card.click();
    return 'ok';
  })()`);
  if (picked !== 'ok') return false;
  await sleep(2000);
  return waitFor(cdp, READY_EXPR, 12000, 500);
}

/** 打开回复输入框（未打开则点击“回复”按钮） */
async function openReplyInput(cdp: CdpSession): Promise<boolean> {
  if (await waitFor(cdp, REPLY_INPUT_READY_EXPR, 3000, 300)) return true;
  await evalValue(cdp, CLICK_REPLY_EXPR);
  return waitFor(cdp, REPLY_INPUT_READY_EXPR, 10000, 300);
}

/** 向回复输入框输入文本（先清空，再分块模拟打字） */
async function typeReplyText(cdp: CdpSession, text: string): Promise<boolean> {
  // 先把输入框滚动到可视区域
  await evalValue(cdp, SCROLL_REPLY_INPUT_INTO_VIEW_EXPR);
  await sleep(500);
  // JS 聚焦（实测本页面鼠标点击会被遮挡层吞掉，JS focus 稳定可靠）
  const focused = await evalValue<boolean>(cdp, FOCUS_REPLY_INPUT_EXPR);
  await sleep(400);
  // 校验焦点确实落在可编辑输入框上
  const isFocused = await evalValue<boolean>(cdp, REPLY_INPUT_FOCUSED_EXPR);
  if (!focused || !isFocused) return false;
  // 清空可能残留的文本
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Delete',
    code: 'Delete',
    windowsVirtualKeyCode: 46,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Delete',
    code: 'Delete',
    windowsVirtualKeyCode: 46,
  });
  await sleep(300);
  for (const seg of splitText(text)) {
    await cdp.send('Input.insertText', { text: seg });
    await sleep(randomRange(60, 160));
  }
  await sleep(400);
  // 补发 input 事件，确保 React 状态同步
  await evalValue(
    cdp,
    `(() => { const el = document.activeElement; if (el) el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`,
  );
  await sleep(400);
  // 验证文本已进入输入框
  const probe = [...text.slice(0, 6)];
  const verified = await evalValue<boolean>(cdp, `(() => {
    const input = (${REPLY_INPUT_FINDER});
    if (!input) return false;
    const t = input.textContent || '';
    return ${JSON.stringify(probe.join(''))}.length > 0 && t.includes(${JSON.stringify(probe.join(''))});
  })()`);
  return verified === true;
}

/** 回复单条评论 */
async function replyOne(cdp: CdpSession, plan: CommentReplyPlan): Promise<CommentReplyResult> {
  const base: CommentReplyResult = {
    commentId: plan.commentId,
    ok: false,
    status: 'error',
  };
  try {
    // 1. 定位目标评论（先按昵称+内容，找不到再退化为仅内容）
    let found = await evalValue<string>(cdp, buildFindCommentExpr(plan, true));
    if (found !== 'ok') {
      found = await evalValue<string>(cdp, buildFindCommentExpr(plan, false));
    }
    // 1.1 第一屏未找到：滚动加载更多评论后重试（评论多时新评论可能在列表下方）
    if (found !== 'ok') {
      for (let i = 0; i < 6; i++) {
        await evalValue(cdp, SCROLL_MORE_EXPR);
        await sleep(randomRange(1200, 2200));
        found = await evalValue<string>(cdp, buildFindCommentExpr(plan, true));
        if (found !== 'ok') {
          found = await evalValue<string>(cdp, buildFindCommentExpr(plan, false));
        }
        if (found === 'ok') break;
      }
    }
    if (found !== 'ok') {
      return {
        ...base,
        status: 'comment_not_found',
        message: '页面滚动加载后仍未找到该评论（可能已被删除或不在评论区）',
      };
    }

    // 2. 已回复检查（避免重复回复）
    const repliedState = await evalValue<string>(cdp, ALREADY_REPLIED_EXPR);
    if (repliedState === 'replied') {
      return { ...base, status: 'already_replied', message: '该评论已有回复，跳过' };
    }

    // 3. 打开回复输入框
    const opened = await openReplyInput(cdp);
    if (!opened) {
      return { ...base, status: 'reply_open_failed', message: '点击回复后输入框未出现' };
    }

    // 4. 输入回复文本
    const typed = await typeReplyText(cdp, plan.reply);
    if (!typed) {
      return { ...base, status: 'reply_open_failed', message: '回复文本未成功输入' };
    }

    // 5. 等待回复发送按钮启用并点击
    const sendReady = await waitForValue(cdp, REPLY_SEND_STATE_EXPR, 10000, 300);
    if (!sendReady || sendReady === 'disabled') {
      return { ...base, status: 'send_failed', message: '回复发送按钮未启用' };
    }
    const clicked = await evalValue<string>(cdp, CLICK_REPLY_SEND_EXPR);
    if (clicked !== 'ok') {
      return { ...base, status: 'send_failed', message: '回复发送按钮点击失败' };
    }

    // 6. 确认发送成功（不重试，避免重复回复）
    const confirmed = await waitForValue(cdp, REPLY_CONFIRM_EXPR, 10000, 400);
    if (!confirmed) {
      return {
        ...base,
        status: 'sent_unconfirmed',
        message: '已点击发送但页面未确认；为避免重复回复不自动重试',
      };
    }
    return { ...base, ok: true, status: 'replied', message: `已发送（${confirmed}）` };
  } catch (e) {
    return { ...base, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 批量回复评论（一次进入作品评论页，逐条回复，回复间隔 8~15 秒模拟真人节奏）
 */
export async function replyCommentsViaPage(
  awemeId: string,
  workTitle: string,
  plans: CommentReplyPlan[],
): Promise<{ ok: boolean; results: CommentReplyResult[]; message?: string }> {
  if (!plans.length) return { ok: true, results: [] };

  // 优先复用已打开的创作者页面；否则连接到任意已登录抖音页面，
  // 在启用 204 守卫后于同一标签内导航到评论管理页（避免新标签在守卫生效前被弹走）
  let page = await findDouyinPage();
  if (!page) {
    page = await findAnyDouyinPage();
    if (!page) {
      logger.info('[comment-page-driver] 未找到已登录的抖音窗口（9222）');
      return { ok: false, results: [], message: '未找到已登录的抖音窗口（9222）' };
    }
  }
  logger.info('[comment-page-driver] 开始，目标作品', awemeId, '待回复数', plans.length);

  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
    // 启用 204 守卫，防止页面被强制跳转到 /messages（404）
    await enableMessagesGuard(cdp);
    // 1. 进入当前作品的评论管理页（已在该作品的评论页则复用，避免无谓刷新）
    const currentUrl = (await evalValue<string>(cdp, 'location.href')) || '';
    const needNavigate =
      !currentUrl.includes('/interactive/comment') ||
      !currentUrl.includes(`item_id=${awemeId}`);
    if (needNavigate) {
      await cdp.send('Page.navigate', { url: COMMENT_PAGE(awemeId) });
      await sleep(4000);
    }

    // 2. 等待评论列表就绪；未就绪时尝试“选择作品”兜底
    const ready = await waitFor(cdp, READY_EXPR, 15000, 500);
    if (!ready) {
      const selected = await selectWorkViaSideSheet(cdp, awemeId, workTitle);
      if (!selected) {
        const curUrl = (await evalValue<string>(cdp, 'location.href')) || '';
        logger.info('[comment-page-driver] 评论管理页加载超时', curUrl);
        return { ok: false, results: [], message: '评论管理页加载超时' };
      }
    }

    // 3. 逐条回复
    const results: CommentReplyResult[] = [];
    for (const plan of plans) {
      const res = await replyOne(cdp, plan);
      results.push(res);
      logger.info('[comment-page-driver]', plan.commentId, res.status, res.message || '');
      // 人类化节奏：每条之间随机停顿 8~15 秒
      if (res.ok || res.status === 'sent_unconfirmed') {
        await sleep(randomRange(8000, 15000));
      }
    }
    return { ok: results.some((r) => r.ok), results };
  } catch (e) {
    return {
      ok: false,
      results: [],
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    cdp.close();
  }
}
