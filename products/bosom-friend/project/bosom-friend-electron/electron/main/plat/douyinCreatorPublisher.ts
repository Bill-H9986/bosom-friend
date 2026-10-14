/**
 * 抖音官方创作页发布器（页面内引擎）
 *
 * 背景：本地 API 直发需要 bd-ticket 反爬签名（依赖外部签名服务器 116.62.154.231:7879，
 * 已失效），新发布大概率 403。抖音官方创作页（creator.douyin.com）的请求由官方前端
 * SDK 自动签名，因此改为在隐藏窗口中驱动官方上传界面完成视频发布：
 * 打开发布页 → 注入本地视频文件 → 等待官方上传/转码 → 填写标题 → 点击官方「发布」按钮。
 * 全程零弹窗、零人工干预；成功返回作品 ID 与分享链接。
 *
 * 注意：本引擎在无抖音登录会话的环境下无法实测页面 DOM，全部选择器采用多候选
 * 弹性匹配，待用户登录后按真实页面结构微调。
 */
import { BrowserWindow } from 'electron'
import { logger } from '../../global/log'
import { SimpleWebSocket } from '../safety/wsClient'

const CDP_BASE = 'http://127.0.0.1:9222'
const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'
const PARTITION = 'persist:zhiyin-douyin'

export interface DouyinVideoJob {
  videoPath: string
  title: string
  timeoutMs?: number
}

export interface DouyinPublishResult {
  videoId: string
  shareLink: string
}

type CdpClient = {
  send: (method: string, params?: any) => Promise<any>
  close: () => void
  events: any[]
  ws: any
};

let publisherWindow: BrowserWindow | null = null
let publishBusy = false

function connectCdp(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    // CDP 连接必须超时：页面卡死/端口被占时不能永久挂起整条发布链路
    const timer = setTimeout(() => reject(new Error('CDP 连接超时: ' + wsUrl)), 15000)
    void SimpleWebSocket.connect(wsUrl).then((ws) => {
      clearTimeout(timer)
      let id = 0
      const pending = new Map<number, (v: any) => void>()
      const events: any[] = []
      ws.onMessage((msg: any) => {
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg.result)
          pending.delete(msg.id)
        } else if (msg.method) {
          events.push(msg)
          if (events.length > 500) events.shift()
          // 204 守卫：抖音创作者页面加载约 4 秒后会被强制跳转到 /messages，
          // 直接 204 拦截该跳转，保证发布页/上传页不被弹走（对齐评论驱动同款守卫）。
          if (msg.method === 'Fetch.requestPaused') {
            const p = msg.params || {}
            const url = String(p.request?.url || '')
            if (/douyin\.com\/messages/.test(url)) {
              void ws.send({ id: ++id, method: 'Fetch.fulfillRequest', params: { requestId: p.requestId, responseCode: 204, responseHeaders: [] } })
            }
            else {
              void ws.send({ id: ++id, method: 'Fetch.continueRequest', params: { requestId: p.requestId } })
            }
          }
        }
      })
      resolve({
        send: (method: string, params: any = {}) =>
          new Promise((res, rej) => {
            const mid = ++id
            // 单条 CDP 命令超时兜底：页面卡死时不能让发布链路永久挂起
            const cmdTimer = setTimeout(() => {
              pending.delete(mid)
              rej(new Error('CDP 命令超时: ' + method))
            }, 15000)
            pending.set(mid, (v: any) => {
              clearTimeout(cmdTimer)
              res(v)
            })
            ws.send({ id: mid, method, params })
          }),
        close: () => ws.close(),
        events,
        ws,
      })
    }).catch(reject)
  })
}
/** 创建/复用隐藏发布窗口（与自动窗口同分区，共享抖音会话） */
async function ensurePublisherWindow(): Promise<BrowserWindow> {
  // 渲染进程崩溃/卡死时 CDP 命令会永久无响应：直接换新窗口，避免整条发布链路挂起
  if (publisherWindow && (publisherWindow.isDestroyed() || publisherWindow.webContents.isCrashed())) {
    try {
      publisherWindow.destroy()
    } catch {
      // 已销毁则忽略
    }
    publisherWindow = null
  }
  if (publisherWindow && !publisherWindow.isDestroyed()) {
    return publisherWindow
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { partition: PARTITION, contextIsolation: false, nodeIntegration: false },
  })
  win.webContents.setBackgroundThrottling(false)
  void win.loadURL(UPLOAD_URL).catch((e) => logger.error('[douyin-creator-publish] 窗口加载失败:', e))
  publisherWindow = win
  win.on('closed', () => { publisherWindow = null })
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.warn('[douyin-creator-publish] 发布窗口渲染进程退出:', details.reason)
    publisherWindow = null
  })
  return win
}

/** 销毁发布窗口，让下一次发布重建全新窗口（CDP 卡死恢复用） */
function resetPublisherWindow(): void {
  if (publisherWindow && !publisherWindow.isDestroyed()) {
    try {
      publisherWindow.destroy()
    } catch {
      // 忽略
    }
  }
  publisherWindow = null
}

/** 找到发布窗口的 CDP 调试地址（app 9222 调试端口） */
async function findWindowTarget(): Promise<string> {
  // 窗口刚创建时页面还没注册到调试端口，轮询等待目标出现
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const list = await fetch(CDP_BASE + '/json/list').then((r) => r.json()) as any[]
      // 上传页切到图文后可能路由到 content/post/image，两种 URL 都算发布窗口
      const hit = list.find((t) => t.type === 'page' && (
        String(t.url || '').includes('creator.douyin.com/creator-micro/content/upload')
        || String(t.url || '').includes('creator.douyin.com/creator-micro/content/post/image')
      ))
      if (hit?.webSocketDebuggerUrl) return hit.webSocketDebuggerUrl
    } catch {
      // 调试端口瞬时不可用，继续重试
    }
    await new Promise((s) => setTimeout(s, 1000))
  }
  throw new Error('未找到抖音发布窗口 CDP 目标')
}

async function withCdp<T>(fn: (cdp: CdpClient) => Promise<T>): Promise<T> {
  logger.info('[douyin-creator-publish] 定位发布窗口 CDP 目标')
  const wsUrl = await findWindowTarget()
  const cdp = await connectCdp(wsUrl)
  try {
    await cdp.send('Runtime.enable', {})
    await cdp.send('Page.enable', {})
    await cdp.send('DOM.enable', {})
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*douyin.com/messages*', requestStage: 'Request' }],
    })
    return await fn(cdp)
  } finally {
    cdp.close()
  }
}

/** 找上传入口并注入本地文件（用 objectId 注入，避免深度 DOM 遍历卡死大页面） */
async function injectFiles(cdp: CdpClient, files: string[], kind: 'video' | 'image'): Promise<boolean> {
  const res = await cdp.send('Runtime.evaluate', {
    expression: `(function(){ var els=[].slice.call(document.querySelectorAll('input[type=file]')); if(!els.length) return null; var el=null; for(var i=0;i<els.length;i++){ if(String(els[i].getAttribute('accept')||'').indexOf('${kind}')>=0){ el=els[i]; break; } } return el; })()`,
    objectGroup: 'zhiyin-upload',
  })
  const objectId = res?.result?.objectId
  if (!objectId)
    return false
  logger.info('[douyin-creator-publish] 已定位' + kind + '上传入口，注入本地文件')
  await cdp.send('DOM.setFileInputFiles', {
    objectId,
    files: files.map(p => p.replace(/\\/g, '/')),
  })
  return true
}

/** 标题输入框是否出现（只认“标题”占位符，避免误命中其它富文本框） */
const TITLE_READY_EXPR = `(function(){ var sels=['input[placeholder*=标题]','input[placeholder*=作品标题]','textarea[placeholder*=标题]','input[data-placeholder*=标题]','.title-input']; for(var i=0;i<sels.length;i++){ var el=document.querySelector(sels[i]); if(el && el.offsetParent!==null) return 'FOUND'; } return null; })()`

/** 填写标题（同一组选择器，顺序与就绪判断一致） */
function buildFillTitleExpr(title: string): string {
  const t = JSON.stringify(title)
  return `(function(){ var WANTED = ${t}; var sels=['input[placeholder*=标题]','input[placeholder*=作品标题]','textarea[placeholder*=标题]','input[data-placeholder*=标题]','.title-input']; var el=null; for(var i=0;i<sels.length;i++){ el=document.querySelector(sels[i]); if(el && el.offsetParent!==null) break; } if (!el) return 'NO_EL';`
    + ` if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, WANTED); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' })); }`
    + ` else { el.focus(); el.textContent = WANTED; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: WANTED })); }`
    + ` var check = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? (el.value||'') : (el.textContent||'');`
    + ` return check.indexOf(WANTED) >= 0 ? 'OK:' + check.length : 'MISMATCH:' + check.slice(0, 40); })()`
}

/** 挂网络探针：记录全部请求轨迹 + 捕获官方创建/发布接口响应（XHR 与 fetch 双通道） */
const INSTALL_CREATE_PROBE_EXPR = `(function(){ window.__dyCreateRes = null; window.__dyReqs = [];`
  + ` var record = function(u, status, body){ if(!window.__dyReqs) window.__dyReqs = [];`
  + `   window.__dyReqs.push({ url: String(u).slice(0, 160), status: status, body: String(body||'').slice(0, 800) });`
  + `   if (window.__dyReqs.length > 40) window.__dyReqs = window.__dyReqs.slice(-40);`
  + `   if (String(body||'').indexOf('aweme_id') >= 0 && String(u).indexOf('work_list') < 0) window.__dyCreateRes = { status: status, url: String(u), body: String(body||'') }; };`
  + ` var OX = XMLHttpRequest.prototype.open, OS = XMLHttpRequest.prototype.send;`
  + ` XMLHttpRequest.prototype.open = function(m, u){ this.__m = m; this.__u = u; return OX.apply(this, arguments); };`
  + ` XMLHttpRequest.prototype.send = function(b){ this.addEventListener('loadend', function(){ try { record(this.__u, this.status, this.responseText || ''); } catch(e){} }); return OS.call(this, b); };`
  + ` var OF = window.fetch; window.fetch = function(){ var a = arguments; var u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url); return OF.apply(this, a).then(function(r){ try { var c = r.clone(); c.text().then(function(t){ record(u, r.status, t); }).catch(function(){}); } catch(e){} return r; }); }; return 'ok'; })()`

/** 等到可点击的“发布”按钮出现并点击（禁用态会一直等，直到上传转码完成启用） */
async function clickEnabledPublish(cdp: CdpClient): Promise<string> {
  const result = await pollValue(
    cdp,
    `(function(){ var btns=[].slice.call(document.querySelectorAll('button')); for(var i=0;i<btns.length;i++){ var t=(btns[i].textContent||'').trim(); if(/^(发布|立即发布|确认发布)$/.test(t) && !btns[i].disabled && btns[i].getAttribute('aria-disabled')!=='true'){ btns[i].click(); return 'CLICKED'; } } return null; })()`,
    (v) => v === 'CLICKED',
    60000,
  )
  if (result !== 'CLICKED') {
    const scene = await evaluate(
      cdp,
      `(function(){ var norm=function(s){ return String(s||'').replace(/\\s+/g,' ').trim(); };`
      + ` var btns=[].slice.call(document.querySelectorAll('button')).map(function(b){ return norm(b.textContent||'') + (b.disabled?':disabled':'') + (b.getAttribute('aria-disabled')==='true'?':aria-disabled':'') }).filter(Boolean);`
      + ` var ins=[].slice.call(document.querySelectorAll('input,textarea,[contenteditable=true]')).filter(function(e){ return e.offsetParent!==null; }).map(function(e){ return (e.tagName==='INPUT'||e.tagName==='TEXTAREA'? e.value : e.textContent || '').slice(0,30); });`
      + ` return JSON.stringify({ href: location.href, btns: btns.slice(-14), ins: ins.slice(-10), body: norm(document.body?document.body.innerText:'').slice(-400) }); })()`,
    )
    logger.warn('[douyin-creator-publish] 发布按钮未在60秒内可用，现场:', String(scene).slice(0, 1400))
  }
  return result
}

/** 等待创建接口回执并解析作品 ID（拿不到时带上页面现场便于排查） */
async function awaitCreateResponse(cdp: CdpClient): Promise<{ videoId: string; verified: boolean }> {
  const deadline = Date.now() + 60000
  let createRes: any = null
  while (Date.now() < deadline) {
    const raw = await evaluate(cdp, 'JSON.stringify(window.__dyCreateRes)')
    if (raw && raw !== 'null') {
      const parsed = JSON.parse(raw)
      // 忽略 aweme_id=0 的“预创建”回执，等真正发布成功的非零作品 ID
      const m = String(parsed?.body || '').match(/aweme_id[^0-9]*(\d+)/)
      if (m && Number(m[1]) > 0) { createRes = parsed; break }
    }
    await new Promise((s) => setTimeout(s, 1000))
  }
  if (!createRes) {
    // 发布后官方会把编辑器跳走（成功跳转到作品管理）：未捕获回执但页面已离开编辑器，视为疑似成功
    const href = await evaluate(cdp, 'location.href')
    if (href && !href.includes('/content/post/image')) {
      logger.info('[douyin-creator-publish] 已点击发布且页面已离开编辑器，视为疑似成功（回执未捕获）:', href)
      return { videoId: '', verified: false }
    }
    logger.warn('[douyin-creator-publish] 未捕获到非零 aweme_id 的创建回执，转储请求轨迹')
    const scene = await evaluate(
      cdp,
      `(function(){ var btns=[].slice.call(document.querySelectorAll('button')).map(function(b){ return (b.textContent||'').trim() + (b.disabled?':disabled':'') }).filter(Boolean); return JSON.stringify({ body: (document.body?document.body.innerText:'').slice(-300), btns: btns.slice(-12), reqs: (window.__dyReqs||[]).slice(-15) }); })()`,
    )
    throw new Error('发布超时：未捕获官方创建接口响应 ' + String(scene).slice(0, 1500))
  }
  logger.info('[douyin-creator-publish] 捕获创建回执:', String(createRes.body).slice(0, 500))
  if (createRes.status !== 200) throw new Error('发布失败：HTTP ' + createRes.status + ' ' + String(createRes.body).slice(0, 300))
  let videoId = ''
  try {
    const parsed = JSON.parse(createRes.body)
    videoId = String(parsed?.aweme?.aweme_id || parsed?.item_id || parsed?.aweme_id || '')
  } catch { /* 响应体非 JSON 时走正则兜底 */ }
  if (!videoId) {
    const m = String(createRes.body).match(/aweme_id[^0-9]*(\d+)/)
    videoId = m ? m[1] : ''
  }
  if (!videoId) throw new Error('发布成功但未解析到作品 ID: ' + String(createRes.body).slice(0, 200))
  return { videoId, verified: true }
}

async function evaluate(cdp: CdpClient, expression: string): Promise<any> {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res?.exceptionDetails) throw new Error(String(res.exceptionDetails.text || '页面执行异常'))
  return res?.result?.value
}

/** 轮询直到条件满足或超时 */
async function pollValue(cdp: CdpClient, expression: string, pred: (v: any) => boolean, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await evaluate(cdp, expression).catch(() => undefined)
    if (pred(v)) return v
    await new Promise((s) => setTimeout(s, 1000))
  }
  return undefined
}
/**
 * 通过官方创作页发布视频。
 * 会话过期（页面停在登录页）时抛出明确错误，由发布结果透传提示用户。
 */
export async function publishVideoViaCreator(job: DouyinVideoJob): Promise<DouyinPublishResult> {
  if (publishBusy) throw new Error('创作页发布器忙，请稍后重试')
  publishBusy = true
  const timeoutMs = job.timeoutMs ?? 300000
  try {
    await ensurePublisherWindow()
    return await withCdp(async (cdp) => {
      // 每次任务重载发布页，避免残留状态
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
      await cdp.send('Page.navigate', { url: UPLOAD_URL })
      await pollValue(
        cdp,
        "document.readyState + '|' + (document.body ? document.body.innerText.length : 0)",
        (v) => typeof v === 'string' && v.startsWith('complete|') && !v.endsWith('|0'),
        30000,
      )
      // 若仍被跳走（守卫未命中旧会话缓存），导航回发布页一次
      const afterLoad = await evaluate(cdp, 'location.href')
      if (afterLoad && !afterLoad.includes('/content/upload') && !afterLoad.includes('/content/post/image')) {
        await cdp.send('Page.navigate', { url: UPLOAD_URL })
        await pollValue(
          cdp,
          "document.readyState + '|' + (document.body ? document.body.innerText.length : 0)",
          (v) => typeof v === 'string' && v.startsWith('complete|') && !v.endsWith('|0'),
          30000,
        )
      }
      // 会话校验：停在登录页直接报错
      const href = await evaluate(cdp, 'location.href')
      if (!href || href.includes('/login')) {
        throw new Error('抖音会话已过期，请到「账号管理」重新登录后再发布')
      }
      const injected = await injectFiles(cdp, [job.videoPath], 'video')
      if (!injected) throw new Error('未找到抖音视频上传输入框（页面结构变化或未登录）')
      logger.info('[douyin-creator-publish] 视频文件已注入，等待官方上传转码')
      // 等待标题输入框出现（上传完成后官方才渲染编辑区）
      const found = await pollValue(
        cdp,
        TITLE_READY_EXPR,
        (v) => v === 'FOUND',
        Math.min(timeoutMs, 240000),
      )
      if (!found) throw new Error('等待标题输入框超时（上传可能失败）')
      // 填标题：优先 input，其次 contenteditable
      const fillRes = await evaluate(cdp, buildFillTitleExpr(job.title))
      if (!fillRes || !String(fillRes).startsWith('OK')) throw new Error('标题填写失败: ' + String(fillRes))
      await new Promise((s) => setTimeout(s, 800))
      // 挂网络探针：捕获官方创建接口响应
      await evaluate(cdp, INSTALL_CREATE_PROBE_EXPR)
      // 触发官方发布：按文本找「发布」按钮（多候选）
      const clicked = await clickEnabledPublish(cdp)
      if (clicked !== 'CLICKED') throw new Error('未找到发布按钮（页面结构变化）')
      logger.info('[douyin-creator-publish] 已点击官方发布，等待创建接口响应')
      const { videoId, verified } = await awaitCreateResponse(cdp)
      if (!verified) logger.warn('[douyin-creator-publish] 视频发布疑似成功但未捕获作品 ID，需平台端核验')
      const shareLink = 'https://www.douyin.com/user/self?from_tab_name=main&modal_id=' + videoId + '&showTab=post'
      logger.info('[douyin-creator-publish] 发布成功 videoId=' + videoId)
      return { videoId, shareLink }
    })
  } finally {
    publishBusy = false
  }
}

/**
 * 抖音图文发布任务
 */
export interface DouyinImageNoteJob {
  images: string[];
  title: string;
  desc?: string;
  timeoutMs?: number;
}

/**
 * 通过官方创作页发布图文。
 * 会话过期（页面停在登录页）时抛出明确错误，由发布结果透传提示用户。
 * 页面结构为盲写多候选匹配，待用户登录后按真实页面校准。
 */
export async function publishImageNoteViaCreator(job: DouyinImageNoteJob): Promise<DouyinPublishResult> {
  if (publishBusy) throw new Error('创作页发布器忙，请稍后重试')
  publishBusy = true
  const timeoutMs = job.timeoutMs ?? 300000
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        logger.info('[douyin-creator-publish] 图文发布开始，标题:', job.title)
        await ensurePublisherWindow()
        logger.info('[douyin-creator-publish] 发布窗口已就绪，开始注入流程')
        return await withCdp(async (cdp) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
      await cdp.send('Page.navigate', { url: UPLOAD_URL })
      await pollValue(
        cdp,
        "document.readyState + '|' + (document.body ? document.body.innerText.length : 0)",
        (v) => typeof v === 'string' && v.startsWith('complete|') && !v.endsWith('|0'),
        30000,
      )
      const afterLoad = await evaluate(cdp, 'location.href')
      if (afterLoad && !afterLoad.includes('/content/upload') && !afterLoad.includes('/content/post/image')) {
        await cdp.send('Page.navigate', { url: UPLOAD_URL })
        await pollValue(
          cdp,
          "document.readyState + '|' + (document.body ? document.body.innerText.length : 0)",
          (v) => typeof v === 'string' && v.startsWith('complete|') && !v.endsWith('|0'),
          30000,
        )
      }
      const href = await evaluate(cdp, 'location.href')
      if (!href || href.includes('/login')) {
        throw new Error('抖音会话已过期，请到「账号管理」重新登录后再发布')
      }
      // 切换到图文模式：等“发布图文”入口出现再点，点完确认图片上传入口真的渲染出来
      const tabReady = await pollValue(
        cdp,
        "(function(){ var els=[].slice.call(document.querySelectorAll('button, span, div, li')); return els.some(function(e){ return (e.textContent||'').trim()==='发布图文' && e.getBoundingClientRect().width>0; }); })()",
        (v) => v === true,
        20000,
      )
      if (!tabReady) {
        logger.warn('[douyin-creator-publish] 未找到“发布图文”入口，尝试直接注入图片')
      }
      else {
        const switched = await evaluate(
          cdp,
          "(function(){ var els = [].slice.call(document.querySelectorAll('button, span, div, li'));"
          + " var hit = null; for (var i = 0; i < els.length; i++) { var t = (els[i].textContent || '').trim(); if (t === '发布图文') { var r = els[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0) { hit = els[i]; break; } } }"
          + " if (!hit) return 'NO_TAB'; hit.click(); return 'CLICKED'; })()",
        )
        logger.info('[douyin-creator-publish] 图文切换:', switched)
      }
      // 处理“你还有上次未发布的图文，是否继续编辑？”：放弃历史草稿，保证干净编辑态
      const discarded = await evaluate(
        cdp,
        "(function(){ var els=[].slice.call(document.querySelectorAll('button,span,div')); var hit=els.find(function(e){ return (e.textContent||'').trim()==='放弃' && e.getBoundingClientRect().width>0; }); if(!hit) return 'NO_DIALOG'; hit.click(); return 'DISCARDED'; })()",
      )
      logger.info('[douyin-creator-publish] 历史草稿弹窗处理:', discarded)
      await new Promise((s) => setTimeout(s, 1200))
      // 图文模式才会渲染 image 文件输入框；等不到就报错，避免误注入到视频入口
      const imageInputReady = await pollValue(
        cdp,
        "(function(){ var els=[].slice.call(document.querySelectorAll('input[type=file]')); return els.some(function(e){ return String(e.getAttribute('accept')||'').indexOf('image')>=0; }); })()",
        (v) => v === true,
        15000,
      )
      if (!imageInputReady) {
        throw new Error('图文模式未就绪：未找到图片上传入口（页面结构变化）')
      }
      const injected = await injectFiles(cdp, job.images, 'image')
      if (!injected) throw new Error('未找到抖音图片上传输入框（页面结构变化或未登录）')
      logger.info('[douyin-creator-publish] 图片已注入，等待官方上传')
      // 上传完成以“发布按钮可用 + 标题输入框出现”为准（回执偶发抓不到，不再依赖它卡流程）
      await new Promise((s) => setTimeout(s, 8000))
      const found = await pollValue(
        cdp,
        TITLE_READY_EXPR,
        (v) => v === 'FOUND',
        Math.min(timeoutMs, 240000),
      )
      if (!found) throw new Error('等待标题输入框超时（上传可能失败）')
      // 抖音图文标题输入框上限 20 字：先截断再填写，校验按截断文本比对
      const fillRes = await evaluate(cdp, buildFillTitleExpr(job.title.slice(0, 20)))
      if (!fillRes || !String(fillRes).startsWith('OK')) throw new Error('标题填写失败: ' + String(fillRes))
      await new Promise((s) => setTimeout(s, 500))
      // 注入后页面会从 upload 跳转到 post/image 编辑器，探针必须在这个新页面上下文里挂载
      await evaluate(cdp, INSTALL_CREATE_PROBE_EXPR)
      const clicked = await clickEnabledPublish(cdp)
      if (clicked !== 'CLICKED') throw new Error('未找到发布按钮（页面结构变化）')
      logger.info('[douyin-creator-publish] 已点击官方发布（图文），等待创建接口响应')
      const { videoId, verified } = await awaitCreateResponse(cdp)
      if (!verified) logger.warn('[douyin-creator-publish] 图文发布疑似成功但未捕获作品 ID，需平台端核验')
      const shareLink = 'https://www.douyin.com/user/self?from_tab_name=main&modal_id=' + videoId + '&showTab=post'
      logger.info('[douyin-creator-publish] 图文发布成功 videoId=' + videoId)
          return { videoId, shareLink }
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (attempt < 2 && /(CDP (命令|连接)超时|未找到抖音发布窗口)/.test(msg)) {
          logger.warn('[douyin-creator-publish] CDP 卡死，重建发布窗口后重试一次:', msg)
          resetPublisherWindow()
          continue
        }
        throw error
      }
    }
    throw new Error('发布失败：CDP 不可用')
  } finally {
    publishBusy = false
  }
}
