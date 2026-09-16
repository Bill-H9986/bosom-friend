/**
 * 浏览器自动化桥（browser-use 能力模型 → CDP 实现）
 *
 * 把内核的 BrowserBridge 协议落到：
 * - embedded：APP 内置浏览器（Electron 9222 调试端口，含隐藏平台窗口）；
 * - chrome/edge 实例：browserControlManager 启动的独立环境（每账号隔离登录态）。
 *
 * 设计对齐 browser-use：后台页面操作、JS 求值取数/校验、选择器定位，
 * 截图与文本读取供 AI 判断页面状态。
 */
import { logger } from '../../global/log';
import {
  connectCdp,
  getTargets,
  openUrl,
  type CdpTarget,
} from '../browserControl/cdp';
import { browserControlManager } from '../browserControl/manager';
import type {
  BrowserBridge,
  BrowserLaunchResult,
  BrowserPageInfo,
} from '../../../../bosom-friend-harness/src/index';

const EMBEDDED_PORT = 9222;
/** 引擎 → 当前操作页（target id），保持跨工具调用的页面上下文 */
const currentByEngine = new Map<string, string>();

function resolvePort(engine: string): number {
  if (engine === 'embedded')
    return EMBEDDED_PORT;
  const instance = browserControlManager
    .listInstances()
    .find((i) => i.id === engine);
  if (instance)
    return instance.port;
  // 兼容直接传浏览器类型：取该类型第一个运行中的实例
  const byKind = browserControlManager
    .listInstances()
    .find((i) => i.kind === engine);
  return byKind?.port ?? -1;
}

async function pageTargets(port: number): Promise<CdpTarget[]> {
  const list = await getTargets(port);
  return list.filter((t) => t.type === 'page' || t.type === 'webview');
}

async function currentTarget(
  engine: string,
  port: number,
): Promise<CdpTarget | null> {
  const pages = await pageTargets(port);
  const saved = currentByEngine.get(engine);
  if (saved) {
    const found = pages.find((t) => t.id === saved);
    if (found)
      return found;
  }
  const first = pages[0];
  if (first) {
    currentByEngine.set(engine, first.id ?? '');
    return first;
  }
  return null;
}

interface CdpSessionLike {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
}

async function withPage<T>(
  engine: string,
  fn: (session: CdpSessionLike, target: CdpTarget) => Promise<T>,
): Promise<T> {
  const port = resolvePort(engine);
  if (port <= 0)
    throw new Error(`浏览器引擎不可用：${engine}（未启动或未检测到）`);
  const target = await currentTarget(engine, port);
  if (!target?.webSocketDebuggerUrl)
    throw new Error(`引擎 ${engine} 没有可用页面`);
  const session = await connectCdp(target.webSocketDebuggerUrl);
  try {
    return await fn(session as CdpSessionLike, target);
  }
  finally {
    session.close();
  }
}

function evaluateScript(expression: string): string {
  return `(() => { try { const __v = (${expression}); return Promise.resolve(__v).then(value => ({ ok: true, value })); } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; } })()`;
}

function clickScript(selector: string, text?: string): string {
  return `(() => {
    const sel = ${JSON.stringify(selector)};
    const text = ${JSON.stringify(text ?? '')};
    const els = Array.from(document.querySelectorAll(sel));
    if (!els.length) return { ok: false, error: '未找到元素: ' + sel };
    const el = text ? els.find(e => (e.innerText || e.textContent || '').includes(text)) : els[0];
    if (!el) return { ok: false, error: '未找到包含文本的元素: ' + text };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.click();
    const label = ((el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).slice(0, 40);
    return { ok: true, detail: el.tagName.toLowerCase() + (label ? ' ' + label : '') };
  })()`;
}

function typeScript(selector: string, text: string): string {
  return `(() => {
    const sel = ${JSON.stringify(selector)};
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: '未找到输入框: ' + sel };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, detail: '输入完成' };
  })()`;
}

async function runInPage(
  engine: string,
  expression: string,
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const result = await withPage(engine, async (session) => {
    const r = await session.send('Runtime.evaluate', {
      expression: evaluateScript(expression),
      returnByValue: true,
      awaitPromise: true,
    });
    const res = (r as { result?: { value?: unknown }; exceptionDetails?: { text?: string } });
    if (res.exceptionDetails) {
      return { ok: false, error: res.exceptionDetails.text || '页面脚本异常' };
    }
    return res.result?.value as { ok: boolean; value?: unknown; error?: string };
  });
  return result ?? { ok: false, error: '页面脚本无返回' };
}

export function buildBrowserBridge(): BrowserBridge {
  return {
    async listPages(): Promise<BrowserPageInfo[]> {
      const pages: BrowserPageInfo[] = [];
      const collect = async (port: number, engine: string) => {
        for (const t of await pageTargets(port)) {
          pages.push({
            id: t.id ?? `${engine}-${t.url.slice(0, 40)}`,
            url: t.url,
            title: t.title || '',
            engine,
          });
        }
      };
      await collect(EMBEDDED_PORT, 'embedded');
      for (const instance of browserControlManager.listInstances()) {
        if (instance.status === 'running') {
          await collect(instance.port, instance.id);
        }
      }
      return pages;
    },

    async launch(kind, url): Promise<BrowserLaunchResult> {
      const instance = await browserControlManager.launchInstance(kind);
      if (instance.status === 'error') {
        throw new Error(instance.error || '浏览器实例启动失败');
      }
      const target = url
        ? await openUrl(instance.port, url)
        : null;
      if (target?.id)
        currentByEngine.set(instance.id, target.id);
      return {
        engine: instance.id,
        url: url || instance.openUrl || '',
        port: instance.port,
      };
    },

    async navigate(engine, url) {
      const port = resolvePort(engine);
      if (port <= 0)
        throw new Error(`浏览器引擎不可用：${engine}`);
      const pages = await pageTargets(port);
      const isAppShell = (t: CdpTarget) =>
        t.url.startsWith('file://')
        || t.url.startsWith('http://localhost')
        || t.url.startsWith('http://127.0.0.1');
      // 平台站点优先复用已登录的对应分区窗口（保持登录态），绝不新开默认分区标签
      const host = (() => {
        try {
          return new URL(url).hostname;
        }
        catch {
          return '';
        }
      })();
      const platformPage = host
        ? pages.find((t) => !isAppShell(t) && t.url.includes(host))
        : undefined;
      if (platformPage) {
        const session = await connectCdp(platformPage.webSocketDebuggerUrl);
        try {
          await session.send('Page.navigate', { url });
        }
        finally {
          session.close();
        }
        currentByEngine.set(engine, platformPage.id ?? '');
        return { pageId: platformPage.id ?? '', url };
      }
      // 新开后台标签页，不动现有页面（避免把 APP 主窗口导航走）
      const target = await openUrl(port, url);
      if (!target?.id) {
        // 优先复用平台后台页（creator.*），绝不导航 APP 主窗口（file:// / localhost）
        const page =
          pages.find((t) => t.url.includes('creator.')) ??
          pages.find((t) => !isAppShell(t));
        if (!page)
          throw new Error(`引擎 ${engine} 无法新开页面；如需新环境请调用 browser.launch 启动独立浏览器实例`);
        const session = await connectCdp(page.webSocketDebuggerUrl);
        try {
          await session.send('Page.navigate', { url });
        }
        finally {
          session.close();
        }
        currentByEngine.set(engine, page.id ?? '');
        return { pageId: page.id ?? '', url };
      }
      currentByEngine.set(engine, target.id);
      return { pageId: target.id, url };
    },

    async evaluate(engine, expression) {
      try {
        return await runInPage(engine, expression);
      }
      catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async click(engine, selector, text) {
      try {
        const r = await runInPage(engine, clickScript(selector, text));
        return { ok: r.ok === true, detail: typeof r.value === 'string' ? r.value : undefined, error: r.error };
      }
      catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async typeText(engine, selector, text) {
      try {
        const r = await runInPage(engine, typeScript(selector, text));
        return { ok: r.ok === true, detail: typeof r.value === 'string' ? r.value : undefined, error: r.error };
      }
      catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async waitFor(engine, selector, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const r = await runInPage(engine, `!!document.querySelector(${JSON.stringify(selector)})`);
          if (r.value === true)
            return { ok: true };
        }
        catch (error) {
          logger.warn('[browser-bridge] 等待选择器出错:', error);
        }
        if (Date.now() >= deadline)
          return { ok: false, error: `等待超时（${timeoutMs}ms）：${selector}` };
        await new Promise((r) => setTimeout(r, 300));
      }
    },

    async screenshot(engine, selector) {
      try {
        const r = await withPage(engine, async (session) => {
          const params: Record<string, unknown> = { format: 'png' };
          if (selector) {
            const rect = await runInPage(engine, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center', behavior: 'instant' }); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
            if (!rect.value)
              return { ok: false, error: `未找到元素：${selector}` };
            const box = rect.value as { x: number; y: number; width: number; height: number };
            params.clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
            params.captureBeyondViewport = false;
          }
          const shot = await session.send('Page.captureScreenshot', params);
          return { ok: true, base64: (shot as { data?: string }).data };
        });
        return { ok: true, base64: r.base64, error: r.error };
      }
      catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async text(engine: string, selector?: string) {
      const expression = selector
        ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`
        : `(() => document.body ? (document.body.innerText || document.body.textContent || '') : '')()`;
      const r = await this.evaluate(engine, expression);
      return {
        ok: r.ok,
        text: typeof r.value === 'string' ? r.value : undefined,
        error: r.error,
      };
    },
  };
}
