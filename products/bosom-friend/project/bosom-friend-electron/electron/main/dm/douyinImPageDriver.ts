/*
 * 抖音私信 · 页面驱动（长期方案 · 创作者私信管理页）
 *
 * 页面：https://creator.douyin.com/creator-micro/data/following/chat
 * 说明：抖音网页版 /messages 对个人账号服务端 404，但创作者中心的“私信管理”页
 *       （following/chat）对个人创作者可用，包含会话列表 + 聊天面板 + 回复输入。
 *
 * 关键机制（实测验证，2026-08-10）：
 *   1) 页面加载后约 4 秒会被 JS 强制跳转到 www.douyin.com/messages（404 页）。
 *      必须用 CDP Fetch 域拦截该导航并返回 204，页面才会驻留。此守卫为前置条件！
 *   2) 点击会话条目里的昵称（[class*='item-header-name']）才打开聊天面板；
 *      点击整行/头像不会打开。
 *   3) 输入用 CDP Input.insertText（真实输入事件）+ 手动派发 InputEvent('input')，
 *      否则 React 编辑器状态不同步、发送按钮不生效。
 *   4) 发送按钮是 button.semi-button-primary.chat-btn，点击后输入框清空即成功。
 *
 * 与评论驱动一致的避坑：鼠标坐标点击会被遮挡层吞掉，一律用 JS focus() + JS click()。
 */

const CDP_BASE = 'http://127.0.0.1:9222';
const CHAT_URL = 'https://creator.douyin.com/creator-micro/data/following/chat';
const MESSAGES_URL_PATTERN = '*www.douyin.com/messages*';
import { SimpleWebSocket } from '../safety/wsClient';
import crypto from 'node:crypto';

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

export interface DmIncomingMessage {
  serverId: string;
  senderName: string;
  text: string;
  createdAt?: string;
}

export type DmSendStatus =
  | 'sent'
  | 'sent_unconfirmed'
  | 'conversation_not_found'
  | 'open_failed'
  | 'input_failed'
  | 'send_click_failed'
  | 'session_invalid'
  | 'error';

export interface DmSendResult {
  ok: boolean;
  status: DmSendStatus;
  message?: string;
}

function connect(wsUrl: string) {
  return new Promise<CdpSession>((resolve) => {
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
        send: (method, params = {}) =>
          new Promise((res) => {
            const mid = ++id;
            pending.set(mid, res);
            ws.send({ id: mid, method, params });
          }),
        close: () => ws.close(),
        ws,
      });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomRange = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min));

async function evalValue<T>(cdp: CdpSession, expression: string): Promise<T | undefined> {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  if (r && (r.exceptionDetails || r.error)) {
    console.log(
      '[dm-page-driver][debug] eval异常:',
      JSON.stringify(r.exceptionDetails || r.error).slice(0, 300),
    );
  }
  return r?.result?.value as T | undefined;
}

async function waitFor(
  cdp: CdpSession,
  expression: string,
  timeoutMs: number,
  intervalMs = 400,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evalValue<boolean>(cdp, expression)) return true;
    } catch {
      // 页面刷新等瞬时错误忽略
    }
    await sleep(intervalMs);
  }
  return false;
}

async function findPage(predicate: (u: string) => boolean): Promise<CdpPage | null> {
  try {
    const list = (await fetch(CDP_BASE + '/json/list').then((r) => r.json())) as CdpPage[];
    return list.find((t) => predicate(t.url)) || null;
  } catch {
    return null;
  }
}

/**
 * 启用 204 守卫：拦截一切到 www.douyin.com/messages 的导航并返回 204，
 * 使创作者页面免于被强制跳走（页面加载约 4 秒后会发生该跳转）。
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

/** 会话面板/列表是否已就绪 */
const CHAT_READY_EXPR = `(() => {
  return document.querySelectorAll("li.semi-list-item").length > 0 ||
    !!document.querySelector("[class*='item-header-name']");
})()`;

/** 页面是否处于失效/被风控状态 */
const SESSION_BROKEN_EXPR = `(() => {
  const bodyText = (document.body ? document.body.innerText : '').slice(0, 400);
  if (bodyText.includes('页面不见啦')) return true;
  if (bodyText.includes('扫码登录') && bodyText.includes('验证码登录')) return true;
  return false;
})()`;

/** 进入私信管理页（已在则复用，避免无谓刷新） */
async function openChatPage(cdp: CdpSession): Promise<'ready' | 'session_invalid' | 'failed'> {
  await enableMessagesGuard(cdp);
  const url = (await evalValue<string>(cdp, 'location.href')) || '';
  if (!url.includes('/data/following/chat')) {
    await cdp.send('Page.navigate', { url: CHAT_URL });
  }
  const ready = await waitFor(cdp, CHAT_READY_EXPR, 15000, 500);
  if (!ready) {
    const broken = await evalValue<boolean>(cdp, SESSION_BROKEN_EXPR);
    return broken ? 'session_invalid' : 'failed';
  }
  return 'ready';
}

/** 打开指定会话的聊天面板（点昵称） */
async function openConversation(cdp: CdpSession, peerName: string): Promise<boolean> {
  const wanted = (peerName || '').replace(/\s+/g, ' ').trim();
  const clicked = await evalValue<string>(cdp, `(() => {
    const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
    const wanted = ${JSON.stringify(wanted)};
    if (!wanted) return 'NO_WANTED';
    // 会话列表项可能是 div/li 且类名带 hash 后缀，直接按昵称元素定位并向上找可点击容器
    const name = [...document.querySelectorAll("[class*='item-header-name']")]
      .find((el) => norm(el.textContent || '') === wanted);
    if (!name) return 'NO_NAME_FOUND';
    let target = name;
    for (let i = 0; i < 5 && target && target !== document.body; i++) {
      const c = typeof target.className === 'string' ? target.className : '';
      if (
        target.tagName === 'LI' ||
        (target.tagName === 'DIV' && /item|conversation|session|list/i.test(c))
      ) break;
      target = target.parentElement;
    }
    if (!target || target === document.body) return 'NO_TARGET:' + (target ? target.tagName : 'null');
    target.click();
    return 'OK_CLICKED:' + target.tagName + ':' + String(target.className).slice(0, 40);
  })()`);
  console.log('[dm-page-driver][debug] openConversation clicked:', clicked);
  if (!clicked || !clicked.startsWith('OK_CLICKED')) return false;
  return waitFor(cdp, `(() => !!document.querySelector("[contenteditable='true']"))()`, 8000, 400);
}

/** 读取当前会话消息文本（按出现顺序） */
const READ_MESSAGES_EXPR = `(() => {
  const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
  const out = [];
  document.querySelectorAll("[class*='box-item-message']").forEach((el) => {
    // 跳过自己发的消息（父容器带 is-me 标记），只处理对方消息
    const p = el.parentElement;
    if (p && /is-me/i.test(typeof p.className === 'string' ? p.className : '')) return;
    const t = norm(el.textContent || '');
    if (t && t.length > 0 && t.length < 600) out.push(t);
  });
  return out;
})()`;

/** 获取会话列表（昵称 + 最后消息） */
const LIST_CONVERSATIONS_EXPR = `(() => {
  const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
  const out = [];
  // 会话项以昵称元素为准（容器可能是 div/li，类名带 hash 后缀）
  const names = [...document.querySelectorAll("[class*='item-header-name']")];
  for (const name of names) {
    const n = norm(name.textContent || '');
    if (!n) continue;
    let item = name;
    for (let i = 0; i < 5 && item && item !== document.body; i++) {
      const c = typeof item.className === 'string' ? item.className : '';
      if (item.tagName === 'LI' || (item.tagName === 'DIV' && /item|conversation|session|list/i.test(c))) break;
      item = item.parentElement;
    }
    const content = item ? item.querySelector("[class*='item-content']") : null;
    const time = item ? item.querySelector("[class*='item-header-time']") : null;
    out.push({
      peerName: n,
      lastText: content ? norm(content.textContent || '') : '',
      time: time ? norm(time.textContent || '') : '',
    });
  }
  return out;
})()`;

const DM_INPUT_FINDER = `document.querySelector("[contenteditable='true']")`;
const DM_INPUT_READY_EXPR = `(() => { return !!(${DM_INPUT_FINDER}); })()`;

/** 分块文本（模拟真实打字节奏） */
function splitText(text: string): string[] {
  const chars = [...text];
  const chunk = 10;
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += chunk) {
    out.push(chars.slice(i, i + chunk).join(''));
  }
  return out.length ? out : [''];
}

/** 输入私信文本并触发 React 状态同步 */
async function typeDmText(cdp: CdpSession, text: string): Promise<boolean> {
  const focused = await evalValue<boolean>(cdp, `(() => {
    const el = (${DM_INPUT_FINDER});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    return document.activeElement === el;
  })()`);
  if (!focused) return false;
  await sleep(400);
  for (const seg of splitText(text)) {
    await cdp.send('Input.insertText', { text: seg });
    await sleep(randomRange(60, 160));
  }
  await sleep(500);
  // 派发 input/change 事件，确保 React 编辑器状态同步
  const synced = await evalValue<string>(cdp, `(() => {
    const el = (${DM_INPUT_FINDER});
    if (!el) return 'no_input';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(600);
  const probe = [...text.slice(0, 6)].join('');
  const verified = await evalValue<boolean>(cdp, `(() => {
    const el = (${DM_INPUT_FINDER});
    if (!el) return false;
    return (el.textContent || '').includes(${JSON.stringify(probe)});
  })()`);
  return verified === true && synced === 'ok';
}

/** 点击发送并确认 */
async function clickSendAndConfirm(cdp: CdpSession): Promise<DmSendResult> {
  const btnState = await evalValue<string>(cdp, `(() => {
    const btn = document.querySelector("button.semi-button-primary.chat-btn");
    if (!btn) return 'no_btn';
    return btn.disabled ? 'disabled' : 'ok';
  })()`);
  if (!btnState || btnState !== 'ok') {
    return { ok: false, status: 'send_click_failed', message: '发送按钮未启用' };
  }
  const clicked = await evalValue<string>(cdp, `(() => {
    const btn = document.querySelector("button.semi-button-primary.chat-btn");
    if (!btn) return null;
    btn.click();
    return 'ok';
  })()`);
  if (clicked !== 'ok') {
    return { ok: false, status: 'send_click_failed', message: '发送按钮点击失败' };
  }
  // 确认：输入框清空 且 消息进入会话
  const confirmed = await waitFor(cdp, `(() => {
    const el = (${DM_INPUT_FINDER});
    return !!el && !((el.textContent || '').trim());
  })()`, 8000, 500);
  if (!confirmed) {
    return {
      ok: true,
      status: 'sent_unconfirmed',
      message: '已点击发送但未确认；为避免重复发送不自动重试',
    };
  }
  return { ok: true, status: 'sent', message: '已发送' };
}

async function getSession(): Promise<{ cdp: CdpSession; page: CdpPage } | null> {
  // 私信专用聊天页；只连该页，避免抢占评论窗口
  const page = await findPage((u) => u.includes('/data/following/chat'));
  if (!page) return null;
  return { cdp: await connect(page.webSocketDebuggerUrl), page };
}

/**
 * 发送私信（按对方昵称定位会话）
 */
export async function sendDmViaPage(
  peerName: string,
  text: string,
): Promise<DmSendResult> {
  const session = await getSession();
  if (!session) {
    return { ok: false, status: 'error', message: '未找到已登录的抖音窗口（9222）' };
  }
  const { cdp } = session;
  try {
    const state = await openChatPage(cdp);
    if (state === 'session_invalid') {
      return {
        ok: false,
        status: 'session_invalid',
        message: '抖音会话失效或被风控拦截，请重新登录后重试',
      };
    }
    if (state !== 'ready') {
      return { ok: false, status: 'open_failed', message: '私信管理页未加载' };
    }

    const opened = await openConversation(cdp, peerName);
    if (!opened) {
      return { ok: false, status: 'conversation_not_found', message: `未找到会话：${peerName}` };
    }
    await sleep(randomRange(800, 1500));

    const typed = await typeDmText(cdp, text);
    if (!typed) {
      return { ok: false, status: 'input_failed', message: '私信文本输入失败' };
    }

    return await clickSendAndConfirm(cdp);
  } catch (e) {
    return {
      ok: false,
      status: 'error',
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    cdp.close();
  }
}

/**
 * 读取指定会话的最新消息（页面驱动）
 */
export async function readDmLatestViaPage(
  peerName: string,
): Promise<{ ok: boolean; messages: DmIncomingMessage[]; sessionInvalid?: boolean }> {
  const session = await getSession();
  if (!session) {
    return { ok: false, messages: [] };
  }
  const { cdp } = session;
  try {
    const state = await openChatPage(cdp);
    console.log('[dm-page-driver][debug] openChatPage:', state);
    if (state === 'session_invalid') {
      return { ok: false, messages: [], sessionInvalid: true };
    }
    if (state !== 'ready') {
      return { ok: false, messages: [] };
    }
    const opened = await openConversation(cdp, peerName);
    console.log('[dm-page-driver][debug] openConversation:', opened, 'peer:', peerName);
    if (!opened) {
      return { ok: false, messages: [] };
    }
    await sleep(randomRange(800, 1500));
    const raw = (await evalValue<string[]>(cdp, READ_MESSAGES_EXPR)) || [];
    const messages: DmIncomingMessage[] = raw.map((t) => ({
      // 用内容哈希做稳定消息 ID，保证同一条消息只被处理一次（去重）
      serverId: `page:${crypto.createHash('md5').update(String(t)).digest('hex').slice(0, 16)}`,
      senderName: peerName,
      text: t,
    }));
    return { ok: true, messages };
  } catch {
    return { ok: false, messages: [] };
  } finally {
    cdp.close();
  }
}

/**
 * 列出所有会话（用于界面展示）
 */
export async function listDmConversationsViaPage(): Promise<{
  ok: boolean;
  conversations: { peerName: string; lastText: string; time: string }[];
  sessionInvalid?: boolean;
}> {
  const session = await getSession();
  if (!session) {
    return { ok: false, conversations: [] };
  }
  const { cdp } = session;
  try {
    const state = await openChatPage(cdp);
    if (state === 'session_invalid') {
      return { ok: false, conversations: [], sessionInvalid: true };
    }
    if (state !== 'ready') {
      return { ok: false, conversations: [] };
    }
    const conversations =
      (await evalValue<
        { peerName: string; lastText: string; time: string }[]
      >(cdp, LIST_CONVERSATIONS_EXPR)) || [];
    return { ok: true, conversations };
  } catch {
    return { ok: false, conversations: [] };
  } finally {
    cdp.close();
  }
}
