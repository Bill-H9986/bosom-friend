/**
 * 小红书官方创作页发布器（官方引擎）
 *
 * 背景：主进程直发 POST https://edith.xiaohongshu.com/web_api/sns/v2/note
 * 需要 X-S/X-T/x-s-common 三重签名，签名与 UA/a1 强绑定，外部签名服务器已失效，
 * 自拼签名持续 406。小红书官方创作页（creator.xiaohongshu.com/publish/publish）
 * 的请求由官方前端 SDK 自动签名，因此改为在隐藏窗口中驱动官方编辑器完成图文发布：
 * 选择上传图文 → 注入本地图片 → 填写标题/正文 → 点击官方"发布"按钮。
 * 全程零弹窗、零人工干预；成功返回笔记 ID 与分享链接。
 */
import { BrowserWindow } from 'electron';
import { logger } from '../../global/log';
import { SimpleWebSocket } from '../safety/wsClient';
import { withLocalCdp } from '../safety/cdpAttach';

const CDP_BASE = 'http://127.0.0.1:9222';
const CREATOR_URL =
  'https://creator.xiaohongshu.com/publish/publish?source=official';
const PLAT_PARTITION = 'persist:zhiyin-xhs';
// 创建接口匹配：官方创建端点为 /web_api/sns/v2/note，页面改版时按「note 创建请求」宽匹配兜底
const NOTE_API_MARK = '/web_api/sns/v2/note';
const NOTE_API_MARK_WIDE = '/note';

export interface XhsImageNoteJob {
  images: string[];
  title: string;
  desc: string;
  /** 话题标签（可选，注入失败不影响发布主流程） */
  topics?: string[];
  timeoutMs?: number;
}

export interface XhsPublishResult {
  noteId: string;
  shareLink: string;
}

type CdpClient = {
  send: (method: string, params?: any) => Promise<any>;
  close: () => void;
  events: any[];
};

let publisherWindow: BrowserWindow | null = null;
let publishBusy = false;

function connectCdp(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    void SimpleWebSocket.connect(wsUrl).then((ws) => {
      let id = 0;
      const pending = new Map<number, (v: any) => void>();
      const events: any[] = [];
      ws.onMessage((msg: any) => {
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg.result);
          pending.delete(msg.id);
        } else if (msg.method) {
          events.push(msg);
          if (events.length > 500) events.shift();
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
        events,
      });
    }).catch(reject);
  });
}

async function ensurePublisherWindow(): Promise<void> {
  if (publisherWindow && !publisherWindow.isDestroyed()) return;
  publisherWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      partition: PLAT_PARTITION,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  publisherWindow.webContents.setBackgroundThrottling(false);
  void publisherWindow.loadURL(CREATOR_URL).catch((e: any) => {
    // 任务内会再次 Page.navigate，首次加载被中止属预期，非任务期间静默
    if (!String(e?.message ?? e).includes('ERR_ABORTED')) {
      logger.error('[xhs-creator-publish] 创作页加载失败:', e);
    }
  });
  publisherWindow.on('closed', () => {
    publisherWindow = null;
  });
}

async function findCreatorTarget(): Promise<string | null> {
  try {
    const res = await fetch(CDP_BASE + '/json/list');
    const list = (await res.json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }>;
    const page = list.find(
      (t) => t.type === 'page' && t.url.includes('creator.xiaohongshu.com'),
    );
    return page?.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

async function withCdp<T>(fn: (cdp: CdpClient) => Promise<T>): Promise<T> {
  // 优先主进程内创作页窗口（webContents.debugger，零端口依赖，打包版稳定）
  const local = await withLocalCdp(
    (url) => url.includes('creator.xiaohongshu.com'),
    (session) => {
      const events: any[] = [];
      const cdp: CdpClient = {
        send: session.send,
        close: session.close,
        events,
      };
      return fn(cdp);
    },
  );
  if (local !== null) return local;
  // 回退：9222 remote-debugging 通道（开发态/老环境）
  const wsUrl = await findCreatorTarget();
  if (!wsUrl) throw new Error('未找到创作页调试目标');
  const cdp = await connectCdp(wsUrl);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function evaluate(
  cdp: CdpClient,
  expression: string,
  awaitPromise = false,
): Promise<any> {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (r?.exceptionDetails) {
    throw new Error(
      '页面执行异常: ' +
        JSON.stringify(r.exceptionDetails).slice(0, 200),
    );
  }
  return r?.result?.value;
}

async function pollValue(
  cdp: CdpClient,
  expression: string,
  predicate: (v: any) => boolean,
  timeoutMs: number,
  stepMs = 1000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression);
    if (predicate(last)) return last;
    await new Promise((s) => setTimeout(s, stepMs));
  }
  return last;
}

async function clickAt(cdp: CdpClient, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x, y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x, y,
    button: 'left',
    clickCount: 1,
  });
}

/** 点击页面上直接文本为 text 的可见元素（跨 shadow DOM 用扁平文档定位） */
async function clickOwnText(
  cdp: CdpClient,
  text: string,
  visibleOnly = true,
): Promise<boolean> {
  const expr =
    '(function(){ const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT); let el;' +
    ' while (el = w.nextNode()) { const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");' +
    '  if (own === ' + JSON.stringify(text) + ') { const r = el.getBoundingClientRect();' +
    '   if (!(' + visibleOnly + ') || (r.width > 0 && r.height > 0)) return JSON.stringify({x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}); } } return null; })()';
  const pos = await evaluate(cdp, expr);
  if (!pos) return false;
  const { x, y } = JSON.parse(pos);
  await clickAt(cdp, x, y);
  return true;
}

/** 通过扁平 DOM（穿透 closed shadow root）定位文本节点所在元素并点击其中心 */
async function clickShadowText(
  cdp: CdpClient,
  text: string,
): Promise<boolean> {
  await cdp.send('DOM.enable', {});
  const fd = await cdp.send('DOM.getFlattenedDocument', {
    depth: -1,
    pierce: true,
  });
  const nodes: any[] = fd?.nodes ?? [];
  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    const kids = nodes.filter((c) => c.parentId === n.nodeId);
    const own = kids
      .filter((c) => c.nodeType === 3)
      .map((c) => c.nodeValue)
      .join('')
      .trim();
    if (own !== text) continue;
    const gm = await cdp.send('DOM.getBoxModel', { nodeId: n.nodeId });
    const q: number[] | undefined = gm?.model?.content;
    if (!q || q.length < 6) continue;
    await clickAt(cdp, Math.round((q[0] + q[4]) / 2), Math.round((q[1] + q[5]) / 2));
    return true;
  }
  return false;
}

async function fillText(
  cdp: CdpClient,
  targetExpr: string,
  text: string,
): Promise<void> {
  const posExpr =
    '(function(){ const el = ' + targetExpr + ';' +
    ' if (!el) return null; const r = el.getBoundingClientRect();' +
    ' return JSON.stringify({x: Math.round(r.x + Math.min(r.width / 2, 60)), y: Math.round(r.y + Math.min(r.height / 2, 40))}); })()';
  const pos = await pollValue(
    cdp,
    posExpr,
    (v) => !!v,
    15000,
  );
  if (!pos) throw new Error('找不到填写目标: ' + targetExpr);
  const { x, y } = JSON.parse(pos);
  await clickAt(cdp, x, y);
  await new Promise((s) => setTimeout(s, 300));
  await cdp.send('Input.insertText', { text });
}

/**
 * 发布前校验小红书创作会话：加载官方发布页，若被重定向到登录页
 * 说明 creator 会话已过期——抛出明确错误（由发布结果透传提示用户手动重新登录），
 * 而不是静默等 90 秒超时。全程零弹窗。
 */
export async function checkXhsCreatorSession(): Promise<void> {
  await ensurePublisherWindow();
  await withCdp(async (cdp) => {
    await cdp.send('Page.navigate', { url: CREATOR_URL });
    const deadline = Date.now() + 15000;
    let url = '';
    while (Date.now() < deadline) {
      const res = await cdp.send('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      });
      url = String(res?.result?.value ?? '');
      if (url && !url.includes('/login')) return;
      await new Promise((s) => setTimeout(s, 1000));
    }
    if (!url || url.includes('/login')) {
      throw new Error('小红书创作会话已过期，请到「账号管理」重新登录后再发布');
    }
  });
}

/**
 * 通过官方创作页发布图文笔记。
 * images 为本地图片绝对路径（jpg/png/webp）。
 */
export async function publishImageNoteViaCreator(
  job: XhsImageNoteJob,
): Promise<XhsPublishResult> {
  if (publishBusy) throw new Error('创作页发布器忙，请稍后重试');
  publishBusy = true;
  const timeoutMs = job.timeoutMs ?? 180000;
  try {
    await ensurePublisherWindow();
    return await withCdp(async (cdp) => {
      // 每次任务都重载发布页，避免残留状态
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send('Runtime.enable', {});
      await cdp.send('Page.navigate', { url: CREATOR_URL });
      await pollValue(
        cdp,
        "document.readyState + '|' + (document.body ? document.body.innerText.length : 0)",
        (v) => typeof v === 'string' && v.startsWith('complete|') && !v.endsWith('|0'),
        30000,
      );
      // 选择"上传图文"（必须是视口内的可见元素；页面存在离屏副本）
      const tabExpr =
        '(function(){ const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT); let el;' +
        ' while (el = w.nextNode()) { const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");' +
        '  if (own === "上传图文") { const r = el.getBoundingClientRect();' +
        '   if (r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.x < window.innerWidth && r.y < window.innerHeight)' +
        '    return JSON.stringify({x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}); } } return null; })()';
      let tabPosStr = await pollValue(cdp, tabExpr, (v) => !!v, 20000);
      if (!tabPosStr) throw new Error('未找到"上传图文"入口');
      let tabPos = JSON.parse(tabPosStr);
      // 点击后校验是否真正切到图片模式（输入框 accept 含 jpg），失败则重试
      let imageMode = false;
      for (let attempt = 0; attempt < 3 && !imageMode; attempt++) {
        await clickAt(cdp, tabPos.x, tabPos.y);
        const accept = await pollValue(
          cdp,
          "(function(){ const i = document.querySelector('input.upload-input'); return i ? (i.accept || '') : ''; })()",
          (v) => typeof v === 'string' && v.length > 0,
          8000,
        );
        if (typeof accept === 'string' && accept.includes('jpg')) {
          imageMode = true;
        } else {
          logger.warn('[xhs-creator-publish] 未切到图片模式(accept=' + accept + ')，重试点击');
          tabPosStr = await pollValue(cdp, tabExpr, (v) => !!v, 5000);
          if (tabPosStr) tabPos = JSON.parse(tabPosStr);
        }
      }
      if (!imageMode) throw new Error('无法切到图片上传模式');
      // 等待图片文件输入框
      await pollValue(
        cdp,
        "!!document.querySelector('input.upload-input')",
        (v) => v === true,
        15000,
      );
      await cdp.send('DOM.enable', {});
      const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const q = await cdp.send('DOM.querySelector', {
        nodeId: doc?.root?.nodeId,
        selector: 'input.upload-input',
      });
      if (!q?.nodeId) throw new Error('未找到图片上传输入框');
      const files = job.images.map((p) => p.replace(/\\/g, '/'));
      await cdp.send('DOM.setFileInputFiles', {
        nodeId: q.nodeId,
        files,
      });
      logger.info('[xhs-creator-publish] 图片已注入，等待官方上传完成');
      // 官方前端的"上传完成"遥测：每张图一个 [apm] sns_web_publish_upload_image console group
      // 上传未完成就点发布会弹"图片上传中"toast 且不发出创建请求
      const uploadDeadline = Date.now() + 120000;
      let uploadsDone = false;
      while (Date.now() < uploadDeadline) {
        const done = cdp.events.filter(
          (m: any) =>
            m.method === 'Runtime.consoleAPICalled' &&
            (m.params?.args ?? []).some(
              (a: any) =>
                typeof a.value === 'string' &&
                a.value.includes('sns_web_publish_upload_image'),
            ),
        ).length;
        if (done >= job.images.length) {
          uploadsDone = true;
          break;
        }
        await new Promise((s) => setTimeout(s, 800));
      }
      if (!uploadsDone) {
        throw new Error('图片上传未在限时内完成（官方遥测未触发）');
      }
      await new Promise((s) => setTimeout(s, 3000));
      logger.info('[xhs-creator-publish] 官方上传完成，等待编辑器就绪');
      // 等待编辑器（标题输入框 + 发布按钮）就绪
      const ready = await pollValue(
        cdp,
        "!!document.querySelector('xhs-publish-btn') && !!([...document.querySelectorAll('input')].find(x => x.placeholder && x.placeholder.includes('标题')))",
        (v) => v === true,
        90000,
      );
      if (ready !== true) {
        const href = await evaluate(cdp, 'location.href');
        throw new Error(
          '编辑器未就绪（当前页面: ' + String(href).slice(-60) + '），可能触发平台风控或页面被跳转',
        );
      }
      // 填写标题与正文（目标消失时按需重试一次）
      await fillText(
        cdp,
        "[...document.querySelectorAll('input')].find(x => x.placeholder && x.placeholder.includes('标题'))",
        job.title,
      );
      await fillText(cdp, "document.querySelector('.ProseMirror')", job.desc);
      const verify = await evaluate(
        cdp,
        "(function(){ const i = [...document.querySelectorAll('input')].find(x => x.placeholder && x.placeholder.includes('标题')); const pm = document.querySelector('.ProseMirror'); return JSON.stringify({title: i ? i.value : '', desc: pm ? pm.innerText : ''}); })()",
      );
      if (!verify?.includes(job.title) || !verify?.includes(job.desc.slice(0, 6))) {
        throw new Error('标题或正文填写校验失败: ' + String(verify).slice(0, 120));
      }
      // 话题注入：官方编辑器的话题输入框（多候选匹配），逐个输入后回车打标签；
      // 注入失败只降级为「无话题发布」，不阻断主流程
      if (Array.isArray(job.topics) && job.topics.length > 0) {
        try {
          const topicSel = "[...document.querySelectorAll('input')].find(x => x.placeholder && (x.placeholder.includes('话题') || x.placeholder.includes('标签')))";
          for (const topic of job.topics.slice(0, 5)) {
            const clean = String(topic || '').replace(/^#/, '').trim()
            if (!clean) continue
            await fillText(cdp, topicSel, clean)
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            })
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            })
            await new Promise((s) => setTimeout(s, 600))
          }
          logger.info('[xhs-creator-publish] 话题已注入:', job.topics.join('、'))
        } catch (topicErr) {
          logger.warn('[xhs-creator-publish] 话题注入失败（降级无话题发布）:', topicErr)
        }
      }
      // 等待官方签名 SDK 就绪：发布请求需要页面内签名（infra_sec_web_api_walify），
      // 签名器未就绪时请求会被静默拦截（无请求发出、无响应可捕获）
      const signerReady = await pollValue(
        cdp,
        "typeof window._webmsxyw === 'function'",
        (v) => v === true,
        30000,
      );
      if (signerReady !== true) {
        throw new Error('官方签名 SDK 未就绪（_webmsxyw 未定义）');
      }
      // 预留反爬脚本（as/sec scripting）加载与初始化时间
      await new Promise((s) => setTimeout(s, 10000));
      // 等待可发布（图片处理完成，submit-disabled=false）
      await pollValue(
        cdp,
        "(document.querySelector('xhs-publish-btn')||{}).getAttribute && (document.querySelector('xhs-publish-btn')||{}).getAttribute('submit-disabled')",
        (v) => v !== 'true',
        60000,
      );
      // 挂网络探针：捕获官方创建接口响应（XHR 与 fetch 双通道）
      await evaluate(
        cdp,
        '(function(){ window.__createRes = null;' +
        ' const OX = XMLHttpRequest.prototype.open, OS = XMLHttpRequest.prototype.send;' +
        ' XMLHttpRequest.prototype.open = function(m, u, ...rest){ this.__m = m; this.__u = u; return OX.call(this, m, u, ...rest); };' +
        ' XMLHttpRequest.prototype.send = function(b){ this.addEventListener("loadend", () => { try { const u = String(this.__u); if ((u.includes(' + JSON.stringify(NOTE_API_MARK) + ')) || (this.__m === "POST" && u.includes(' + JSON.stringify(NOTE_API_MARK_WIDE) + '))) window.__createRes = {status: this.status, body: String(this.responseText || "")}; } catch(e){} }); return OS.call(this, b); };' +
        ' const OF = window.fetch; window.fetch = function(...a){ const u = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url); return OF.apply(this, a).then(async (r) => { try { const s = String(u); if (s.includes(' + JSON.stringify(NOTE_API_MARK) + ') || (String(a[1] && a[1].method || "GET").toUpperCase() === "POST" && s.includes(' + JSON.stringify(NOTE_API_MARK_WIDE) + '))) window.__createRes = {status: r.status, body: await r.clone().text()}; } catch(e){} return r; }); }; return "ok"; })()',
      );
      // 触发官方发布：官方按钮位于 closed shadow root 内，坐标点击可能命中离屏副本；
      // 官方自定义元素 <xhs-publish-btn> 的 Vue 监听器直接挂在元素上，
      // 派发其内部按钮同款 'publish' 事件即可稳定触发发布流程。
      await evaluate(
        cdp,
        "(function(){ const ce = document.querySelector('xhs-publish-btn'); if (!ce) return 'NO_CE'; ce.dispatchEvent(new CustomEvent('publish', {bubbles: true, composed: true})); return 'DISPATCHED'; })()",
      );
      logger.info('[xhs-creator-publish] 已触发官方发布事件，等待结果');
      // 等待创建接口响应（以触发时刻为基准计时）
      const deadline = Date.now() + 120000;
      let createRes: any = null;
      while (Date.now() < deadline) {
        const raw = await evaluate(cdp, 'JSON.stringify(window.__createRes)');
        if (raw && raw !== 'null') {
          createRes = JSON.parse(raw);
          break;
        }
        await new Promise((s) => setTimeout(s, 800));
      }
      if (!createRes) {
        // 兜底：坐标点击 shadow 内"发布"按钮后再次等待
        logger.warn('[xhs-creator-publish] 事件触发未生效，回退坐标点击');
        await clickShadowText(cdp, '发布');
        const deadline2 = Date.now() + 30000;
        while (Date.now() < deadline2 && !createRes) {
          const raw = await evaluate(cdp, 'JSON.stringify(window.__createRes)');
          if (raw && raw !== 'null') createRes = JSON.parse(raw);
          else await new Promise((s) => setTimeout(s, 800));
        }
      }
      if (!createRes) {
        const tail = cdp.events
          .filter((m: any) => m.method === 'Runtime.consoleAPICalled')
          .slice(-8)
          .map((m: any) =>
            (m.params?.args ?? [])
              .map((a: any) => String(a.value ?? a.description ?? '').slice(0, 100))
              .join(' '),
          )
          .join(' | ');
        throw new Error('发布超时：未捕获官方创建接口响应。console: ' + tail.slice(-400));
      }
      if (createRes.status !== 200) {
        throw new Error('发布失败：HTTP ' + createRes.status + ' ' + createRes.body.slice(0, 300));
      }
      const parsed = JSON.parse(createRes.body);
      if (!parsed?.success || !parsed?.data?.id) {
        throw new Error('发布失败：' + createRes.body.slice(0, 300));
      }
      const noteId: string = parsed.data.id;
      const shareLink: string =
        parsed.share_link ??
        'https://www.xiaohongshu.com/discovery/item/' + noteId;
      logger.info('[xhs-creator-publish] 发布成功 noteId=' + noteId + ' link=' + shareLink);
      return { noteId, shareLink };
    });
  } finally {
    publishBusy = false;
  }
}

/**
 * 小红书视频发布任务
 */
export interface XhsVideoNoteJob {
  videoPath: string;
  title: string;
  desc: string;
  topics?: string[];
  timeoutMs?: number;
}

/**
 * 通过官方创作页发布视频（与图文同引擎同页面）。
 * 会话过期（页面停在登录页）时抛出明确错误，由发布结果透传提示用户。
 * 视频上传完成以官方遥测 console 分组计数判定，待用户登录后按真实页面校准。
 */
export async function publishVideoNoteViaCreator(
  job: XhsVideoNoteJob,
): Promise<XhsPublishResult> {
  if (publishBusy) throw new Error('创作页发布器忙，请稍后重试');
  publishBusy = true;
  const timeoutMs = job.timeoutMs ?? 300000;
  try {
    await ensurePublisherWindow();
    return await withCdp(async (cdp) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send('Runtime.enable', {});
      await cdp.send('Page.navigate', { url: CREATOR_URL });
      await pollValue(
        cdp,
        "document.readyState + '|' + (document.body ? document.body.innerText.length : 0)",
        (v) => typeof v === 'string' && v.startsWith('complete|') && !v.endsWith('|0'),
        30000,
      );
      // 会话校验：停在登录页直接报错
      const href = await evaluate(cdp, 'location.href');
      if (!href || href.includes('/login')) {
        throw new Error('小红书创作会话已过期，请到「账号管理」重新登录后再发布');
      }
      // 选择"上传视频"（与图文同款可见元素命中策略）
      const tabExpr =
        '(function(){ const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT); let el;' +
        ' while (el = w.nextNode()) { const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");' +
        '  if (own === "上传视频") { const r = el.getBoundingClientRect();' +
        '   if (r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.x < window.innerWidth && r.y < window.innerHeight)' +
        '    return JSON.stringify({x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}); } } return null; })()';
      let tabPosStr = await pollValue(cdp, tabExpr, (v) => !!v, 20000);
      if (!tabPosStr) throw new Error('未找到"上传视频"入口');
      let tabPos = JSON.parse(tabPosStr);
      // 点击后校验是否切到视频模式（输入框 accept 含 video/mp4），失败重试
      let videoMode = false;
      for (let attempt = 0; attempt < 3 && !videoMode; attempt++) {
        await clickAt(cdp, tabPos.x, tabPos.y);
        const accept = await pollValue(
          cdp,
          "(function(){ const i = document.querySelector('input.upload-input'); return i ? (i.accept || '') : ''; })()",
          (v) => typeof v === 'string' && v.length > 0,
          8000,
        );
        if (typeof accept === 'string' && (accept.includes('mp4') || accept.includes('video'))) {
          videoMode = true;
        } else {
          logger.warn('[xhs-creator-publish] 未切到视频模式(accept=' + accept + ')，重试点击');
          tabPosStr = await pollValue(cdp, tabExpr, (v) => !!v, 5000);
          if (tabPosStr) tabPos = JSON.parse(tabPosStr);
        }
      }
      if (!videoMode) throw new Error('无法切到视频上传模式');
      await pollValue(
        cdp,
        "!!document.querySelector('input.upload-input')",
        (v) => v === true,
        15000,
      );
      await cdp.send('DOM.enable', {});
      const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const q = await cdp.send('DOM.querySelector', {
        nodeId: doc?.root?.nodeId,
        selector: 'input.upload-input',
      });
      if (!q?.nodeId) throw new Error('未找到视频上传输入框');
      await cdp.send('DOM.setFileInputFiles', {
        nodeId: q.nodeId,
        files: [job.videoPath.replace(/\\/g, '/')],
      });
      logger.info('[xhs-creator-publish] 视频已注入，等待官方上传完成');
      // 官方前端的"上传完成"遥测：视频一个 [apm] sns_web_publish_upload_video console group
      const uploadDeadline = Date.now() + 240000;
      let uploadsDone = false;
      while (Date.now() < uploadDeadline) {
        const done = cdp.events.filter(
          (m: any) =>
            m.method === 'Runtime.consoleAPICalled' &&
            (m.params?.args ?? []).some(
              (a: any) =>
                typeof a.value === 'string' &&
                (a.value.includes('sns_web_publish_upload_video') || a.value.includes('sns_web_publish_upload_image')),
            ),
        ).length;
        if (done >= 1) {
          uploadsDone = true;
          break;
        }
        await new Promise((s) => setTimeout(s, 800));
      }
      if (!uploadsDone) {
        throw new Error('视频上传未在限时内完成（官方遥测未触发）');
      }
      // 等待编辑器（标题输入框 + 发布按钮）就绪（视频转码可能较久）
      const ready = await pollValue(
        cdp,
        "!!document.querySelector('xhs-publish-btn') && !!([...document.querySelectorAll('input')].find(x => x.placeholder && x.placeholder.includes('标题')))",
        (v) => v === true,
        240000,
      );
      if (ready !== true) {
        const href2 = await evaluate(cdp, 'location.href');
        throw new Error(
          '编辑器未就绪（当前页面: ' + String(href2).slice(-60) + '），可能触发平台风控或页面被跳转',
        );
      }
      // 填写标题与正文
      await fillText(
        cdp,
        "[...document.querySelectorAll('input')].find(x => x.placeholder && x.placeholder.includes('标题'))",
        job.title,
      );
      await fillText(cdp, "document.querySelector('.ProseMirror')", job.desc);
      const verify = await evaluate(
        cdp,
        "(function(){ const i = [...document.querySelectorAll('input')].find(x => x.placeholder && x.placeholder.includes('标题')); const pm = document.querySelector('.ProseMirror'); return JSON.stringify({title: i ? i.value : '', desc: pm ? pm.innerText : ''}); })()",
      );
      if (!verify?.includes(job.title) || !verify?.includes(job.desc.slice(0, 6))) {
        throw new Error('标题或正文填写校验失败: ' + String(verify).slice(0, 120));
      }
      // 话题注入（与图文相同策略，失败降级）
      if (Array.isArray(job.topics) && job.topics.length > 0) {
        try {
          const topicSel = "[...document.querySelectorAll('input')].find(x => x.placeholder && (x.placeholder.includes('话题') || x.placeholder.includes('标签')))";
          for (const topic of job.topics.slice(0, 5)) {
            const clean = String(topic || '').replace(/^#/, '').trim()
            if (!clean) continue
            await fillText(cdp, topicSel, clean)
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            })
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            })
            await new Promise((s) => setTimeout(s, 600))
          }
        } catch (topicErr) {
          logger.warn('[xhs-creator-publish] 视频话题注入失败（降级无话题发布）:', topicErr)
        }
      }
      // 以下发布触发与结果解析与图文完全一致
      const signerReady = await pollValue(
        cdp,
        "typeof window._webmsxyw === 'function'",
        (v) => v === true,
        30000,
      );
      if (signerReady !== true) {
        throw new Error('官方签名 SDK 未就绪（_webmsxyw 未定义）');
      }
      await new Promise((s) => setTimeout(s, 10000));
      await pollValue(
        cdp,
        "(document.querySelector('xhs-publish-btn')||{}).getAttribute && (document.querySelector('xhs-publish-btn')||{}).getAttribute('submit-disabled')",
        (v) => v !== 'true',
        60000,
      );
      await evaluate(
        cdp,
        '(function(){ window.__createRes = null;' +
        ' const OX = XMLHttpRequest.prototype.open, OS = XMLHttpRequest.prototype.send;' +
        ' XMLHttpRequest.prototype.open = function(m, u, ...rest){ this.__m = m; this.__u = u; return OX.call(this, m, u, ...rest); };' +
        ' XMLHttpRequest.prototype.send = function(b){ this.addEventListener("loadend", () => { try { const u = String(this.__u); if ((u.includes(' + JSON.stringify(NOTE_API_MARK) + ')) || (this.__m === "POST" && u.includes(' + JSON.stringify(NOTE_API_MARK_WIDE) + '))) window.__createRes = {status: this.status, body: String(this.responseText || "")}; } catch(e){} }); return OS.call(this, b); };' +
        ' const OF = window.fetch; window.fetch = function(...a){ const u = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url); return OF.apply(this, a).then(async (r) => { try { const s = String(u); if (s.includes(' + JSON.stringify(NOTE_API_MARK) + ') || (String(a[1] && a[1].method || "GET").toUpperCase() === "POST" && s.includes(' + JSON.stringify(NOTE_API_MARK_WIDE) + '))) window.__createRes = {status: r.status, body: await r.clone().text()}; } catch(e){} return r; }); }; return "ok"; })()',
      );
      await evaluate(
        cdp,
        "(function(){ const ce = document.querySelector('xhs-publish-btn'); if (!ce) return 'NO_CE'; ce.dispatchEvent(new CustomEvent('publish', {bubbles: true, composed: true})); return 'DISPATCHED'; })()",
      );
      logger.info('[xhs-creator-publish] 视频已触发官方发布事件，等待结果');
      const deadline = Date.now() + 120000;
      let createRes: any = null;
      while (Date.now() < deadline) {
        const raw = await evaluate(cdp, 'JSON.stringify(window.__createRes)');
        if (raw && raw !== 'null') {
          createRes = JSON.parse(raw);
          break;
        }
        await new Promise((s) => setTimeout(s, 800));
      }
      if (!createRes) {
        logger.warn('[xhs-creator-publish] 视频事件触发未生效，回退坐标点击');
        await clickShadowText(cdp, '发布');
        const deadline2 = Date.now() + 30000;
        while (Date.now() < deadline2 && !createRes) {
          const raw = await evaluate(cdp, 'JSON.stringify(window.__createRes)');
          if (raw && raw !== 'null') createRes = JSON.parse(raw);
          else await new Promise((s) => setTimeout(s, 800));
        }
      }
      if (!createRes) throw new Error('视频发布超时：未捕获官方创建接口响应');
      if (createRes.status !== 200) {
        throw new Error('发布失败：HTTP ' + createRes.status + ' ' + createRes.body.slice(0, 300));
      }
      const parsed = JSON.parse(createRes.body);
      if (!parsed?.success || !parsed?.data?.id) {
        throw new Error('发布失败：' + createRes.body.slice(0, 300));
      }
      const noteId: string = parsed.data.id;
      const shareLink: string =
        parsed.share_link ??
        'https://www.xiaohongshu.com/discovery/item/' + noteId;
      logger.info('[xhs-creator-publish] 视频发布成功 noteId=' + noteId + ' link=' + shareLink);
      return { noteId, shareLink };
    });
  } finally {
    publishBusy = false;
  }
}
