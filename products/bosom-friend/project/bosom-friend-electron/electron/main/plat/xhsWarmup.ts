/**
 * 小红书会话养号器（网页模拟真人浏览）
 *
 * 背景：平台风控将自动化会话判定为异常后，会阶梯式收紧权限（300011/-104/会话降级）。
 * 本模块在隐藏窗口中低频率模拟真人浏览行为（滚动信息流、点开笔记、停留阅读、返回），
 * 让会话保持"人类活动"特征，帮助风控评分自然恢复。
 * 安全边界：只浏览不互动（不点赞/不关注/不评论），每次 2~4 分钟，间隔 35~50 分钟，
 * 全部在隐藏窗口内完成，零弹窗、零用户打扰。
 */
import { BrowserWindow } from 'electron';
import { logger } from '../../global/log';

const PLAT_PARTITION = 'persist:zhiyin-xhs';
const EXPLORE_URL = 'https://www.xiaohongshu.com/explore';

let warmupWindow: BrowserWindow | null = null;
let warmupRunning = false;
let lastWarmupAt = 0;

const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
const rand = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min));

function ensureWindow(): BrowserWindow {
  if (warmupWindow && !warmupWindow.isDestroyed()) return warmupWindow;
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      partition: PLAT_PARTITION,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);
  // 渲染崩溃自愈：置空引用并在下一轮养号时重建，绝不让崩溃拖垮整个 APP
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.warn('[xhs-warmup] 养号窗口渲染进程退出:', details.reason);
    if (warmupWindow === win) {
      warmupWindow = null;
    }
    if (!win.isDestroyed()) {
      win.destroy();
    }
  });
  win.on('closed', () => {
    if (warmupWindow === win) {
      warmupWindow = null;
    }
  });
  warmupWindow = win;
  return win;
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
  if (r?.exceptionDetails) return undefined;
  return r?.result?.value;
}

async function humanScroll(win: BrowserWindow, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await cmd(win, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: rand(500, 900),
      y: rand(300, 600),
      deltaX: 0,
      deltaY: rand(400, 1000),
    });
    await sleep(rand(1500, 5000));
  }
}

/** 打开一篇信息流笔记并"阅读"后返回（模拟真人点开-停留-返回） */
async function readRandomNote(win: BrowserWindow): Promise<boolean> {
  try {
    const linksStr = await evalIn(
      win,
      "JSON.stringify([...document.querySelectorAll('a[href*=\"/explore/\"]')].map(a => a.href).filter(h => !h.includes('xsec_token=') || h.includes('xsec_source=pc_feed')).slice(0, 8))",
    );
    if (!linksStr) return false;
    const links: string[] = JSON.parse(linksStr);
    const filtered = links.filter((l) => l.includes('/explore/'));
    if (filtered.length === 0) return false;
    const pick = filtered[rand(0, filtered.length)];
    await cmd(win, 'Page.navigate', { url: pick });
    await sleep(rand(12000, 22000)); // 阅读停留
    await humanScroll(win, rand(2, 4));
    await cmd(win, 'Page.navigate', { url: EXPLORE_URL });
    await sleep(rand(4000, 8000));
    return true;
  } catch {
    return false;
  }
}

/** 执行一轮养号浏览（2~4 分钟） */
async function runWarmupSession(): Promise<void> {
  if (warmupRunning) return;
  warmupRunning = true;
  const started = Date.now();
  try {
    const win = ensureWindow();
    await cmd(win, 'Page.navigate', { url: EXPLORE_URL });
    await sleep(rand(8000, 12000));
    // 主信息流浏览
    await humanScroll(win, rand(6, 10));
    // 概率性点开 1~2 篇笔记阅读
    const reads = Math.random() < 0.7 ? rand(1, 3) : 0;
    for (let i = 0; i < reads; i++) {
      const ok = await readRandomNote(win);
      if (!ok) break;
    }
    // 收尾滚动
    await humanScroll(win, rand(2, 4));
    const spent = Math.round((Date.now() - started) / 1000);
    logger.info(
      '[xhs-warmup] 养号浏览完成，用时',
      spent + 's，',
      '阅读笔记',
      reads + '篇',
    );
  } catch (e) {
    logger.warn('[xhs-warmup] 养号浏览异常（不影响主流程）:', e);
  } finally {
    warmupRunning = false;
    lastWarmupAt = Date.now();
  }
}

/** 启动养号循环：每 35~50 分钟一次，避免任何定时器抖动（不在整点触发） */
export function startXhsWarmup(): void {
  const tick = async () => {
    const interval = rand(35, 51) * 60 * 1000;
    setTimeout(async () => {
      await runWarmupSession();
      void tick();
    }, interval);
  };
  // 启动后延迟 15 分钟才开始第一轮，避开应用启动高峰
  setTimeout(() => {
    void runWarmupSession();
    void tick();
  }, 15 * 60 * 1000);
  logger.info('[xhs-warmup] 养号器已启动（隐藏窗口，低频率模拟真人浏览）');
}
