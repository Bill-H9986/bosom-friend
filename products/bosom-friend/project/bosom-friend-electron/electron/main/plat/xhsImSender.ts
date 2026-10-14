/**
 * 小红书私信发送器（官方聊天页引擎）
 *
 * 背景：旧的 REST 发送端点（/api/sns/web/v1/im/send）走 jarvis 网关已废弃；
 * 网页版 IM 的发送由官方前端通过内部通道完成。本模块在隐藏窗口中打开官方聊天页
 * （www.xiaohongshu.com/chat/<peer>），定位官方输入框，注入文本并回车发送——
 * 签名与协议由官方前端维护，无第三方依赖；窗口隐藏，零弹窗。
 */
import { BrowserWindow } from 'electron';
import { logger } from '../../global/log';

const PLAT_PARTITION = 'persist:zhiyin-xhs';
const CHAT_BASE = 'https://www.xiaohongshu.com/chat/';
// 候选选择器禁止出现引号：会被拼接进 Runtime.evaluate 表达式导致 SyntaxError
const INPUT_CANDIDATES = [
  '.xhs-im-input-bar-editor[contenteditable]',
  '.xhs-im-input-bar-editor',
  '[contenteditable]',
];
// 发送后落屏确认：会话内最后一条消息气泡包含所发文本才算成功
const LAST_BUBBLE_EXPR =
  "(function(){ const bubbles = document.querySelectorAll('.chat-item[data-message-id] .chat-item__bubble, .chat-item__bubble');" +
  " if (!bubbles.length) return ''; const last = bubbles[bubbles.length - 1];" +
  " return (last.innerText || last.textContent || '').trim(); })()";
// 气泡类名弹性兜底：官方改版后按 [class*=bubble] 宽匹配最后一条消息
const BUBBLE_FALLBACK_EXPR =
  "(function(){ const els = document.querySelectorAll('[class*=bubble]');" +
  " if (!els.length) return ''; const last = els[els.length - 1];" +
  " return (last.innerText || last.textContent || '').trim(); })()";

async function resolveInputSelector(
  win: BrowserWindow,
): Promise<string | null> {
  for (const candidate of INPUT_CANDIDATES) {
    const found = await evalIn(
      win,
      "!!document.querySelector('" + candidate + "')",
    );
    if (found === true) return candidate;
  }
  return null;
}

let senderWindow: BrowserWindow | null = null;
let currentPeer = '';
let sendBusy = false;

function ensureWindow(): BrowserWindow {
  if (senderWindow && !senderWindow.isDestroyed()) return senderWindow;
  senderWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      partition: PLAT_PARTITION,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  senderWindow.webContents.setBackgroundThrottling(false);
  senderWindow.on('closed', () => {
    senderWindow = null;
    currentPeer = '';
  });
  return senderWindow;
}

async function cmd(win: BrowserWindow, method: string, params: any = {}) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  return await dbg.sendCommand(method, params);
}

async function evalIn(win: BrowserWindow, expression: string): Promise<any> {
  const r: any = await cmd(win, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
  }
  return r?.result?.value;
}

const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
const rand = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min));

/**
 * 通过官方聊天页向指定会话发送文本消息。
 * 返回形状与旧 sendImMessage 一致：{ data: { code, success, msg? } }。
 */
export async function sendXhsChatMessage(
  peerId: string,
  content: string,
): Promise<any> {
  if (!peerId || !content.trim()) {
    return { data: { code: -1, success: false, msg: '会话或内容为空' } };
  }
  if (sendBusy) {
    return { data: { code: -1, success: false, msg: '发送器忙，请稍后重试' } };
  }
  sendBusy = true;
  try {
    const win = ensureWindow();
    if (currentPeer !== peerId) {
      await cmd(win, 'Page.navigate', { url: CHAT_BASE + peerId });
      currentPeer = peerId;
    }
    // 弹性解析官方输入框（候选选择器降级，吸收 ZhiYin-kern 弹性选择器设计）
    let inputSelector: string | null = null;
    for (let i = 0; i < 50 && !inputSelector; i++) {
      await sleep(1000);
      inputSelector = await resolveInputSelector(win);
    }
    if (!inputSelector) {
      return { data: { code: -1, success: false, msg: '聊天输入框未就绪（页面可能未登录或结构变更）' } };
    }
    const posStr = await evalIn(
      win,
      "(function(){ const e = document.querySelector('" + inputSelector + "'); const r = e.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + Math.min(r.width / 2, 40)), y: Math.round(r.y + r.height / 2)}); })()",
    );
    const { x, y } = JSON.parse(posStr);
    // 模拟真人节奏（对标 ChatGPT-On-CS 的"延时随机回复"）：点击输入前随机停顿 2~6 秒
    await sleep(rand(2000, 6000));
    await cmd(win, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cmd(win, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(400);
    await cmd(win, 'Input.insertText', { text: content });
    await sleep(400);
    await cmd(win, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cmd(win, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    // 验证：输入框被官方清空，或会话最后一条消息气泡出现所发文本（双信号，任一命中即成功）
    for (let i = 0; i < 15; i++) {
      await sleep(800);
      const editor = await evalIn(
        win,
        "(document.querySelector('" + inputSelector + "') || {innerText: ''}).innerText || ''",
      );
      const editorCleared = typeof editor === 'string' && editor.trim() === '';
      if (editorCleared) {
        logger.info('[xhs-im-sender] 私信已发送 ->', peerId, '内容:', content.slice(0, 40));
        return { data: { code: 0, success: true } };
      }
      const lastBubble = await evalIn(win, LAST_BUBBLE_EXPR);
      const lastBubble2 = await evalIn(win, BUBBLE_FALLBACK_EXPR);
      if (
        (typeof lastBubble === 'string' && lastBubble.includes(content.trim()))
        || (typeof lastBubble2 === 'string' && lastBubble2.includes(content.trim()))
      ) {
        logger.info('[xhs-im-sender] 私信已发送并确认落屏 ->', peerId, '内容:', content.slice(0, 40));
        return { data: { code: 0, success: true } };
      }
    }
    // 失败快照：记录页面 URL 与结构样本，便于页面改版时快速定位
    const failUrl = await evalIn(win, 'location.href').catch(() => '');
    const failBody = await evalIn(win, "(document.body ? document.body.innerText : '').slice(0, 200)").catch(() => '');
    logger.warn('[xhs-im-sender] 发送验证超时 快照 url=', failUrl, 'body=', failBody);
    return { data: { code: -1, success: false, msg: '发送验证超时（输入框未清空且消息未落屏）' } };
  } catch (e) {
    logger.error('[xhs-im-sender] 发送异常:', e);
    return { data: { code: -1, success: false, msg: e instanceof Error ? e.message : String(e) } };
  } finally {
    sendBusy = false;
  }
}
