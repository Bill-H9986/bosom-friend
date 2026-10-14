// 持久抓包：hook 页面 fetch + XHR，捕获抖音评论相关请求并写入本地文件
import fs from 'node:fs';

const OUT = 'C:/Users/Jay/AppData/Local/Temp/comment-reply-capture.json';
const targets = await fetch('http://127.0.0.1:9223/json/list').then(r => r.json());
const page = targets.find(t => t.type === 'page' && (t.url.includes('creator.douyin.com') || t.url.includes('douyin.com')));
if (!page) { console.error('NO DOUYIN PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) { return new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); }); }

const captured = [];
function save() {
  fs.writeFileSync(OUT, JSON.stringify(captured, null, 2), 'utf8');
}

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (msg.method === 'Network.requestWillBeSent') {
    const u = msg.params.request.url;
    if (/comment|reply|publish/.test(u) && /douyin\.com/.test(u)) {
      const entry = {
        url: u,
        method: msg.params.request.method,
        postData: msg.params.request.postData || '',
        headers: msg.params.request.headers,
        ts: Date.now(),
      };
      captured.push(entry);
      save();
      console.log('CAPTURED', entry.method, u.slice(0, 120), '->', OUT);
    }
  }
};

await new Promise(r => ws.onopen = r);
await send('Network.enable');
await send('Runtime.evaluate', {
  expression: `(() => {
    if (window.__capAll) return 'already';
    window.__capAll = [];
    const save = (e) => { window.__capAll.push(e); };
    const of = window.fetch;
    window.fetch = function(...a) {
      const u = String(a[0]);
      if (/comment|reply|publish/.test(u) && /douyin\.com/.test(u)) {
        let body = ''; try { body = (a[1] && a[1].body) || ''; if (typeof body !== 'string') body = ''; } catch {}
        save({ kind: 'fetch', url: u.slice(0, 600), method: (a[1] && a[1].method) || 'GET', body: body.slice(0, 1200), headers: JSON.stringify((a[1] && a[1].headers) || {}) });
      }
      return of.apply(this, a);
    };
    const oo = window.XMLHttpRequest.prototype.open;
    const os = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function(method, url) { this.__m = method; this.__u = String(url); return oo.apply(this, arguments); };
    window.XMLHttpRequest.prototype.send = function(body) {
      if (/comment|reply|publish/.test(this.__u || '') && /douyin\.com/.test(this.__u || '')) {
        save({ kind: 'xhr', url: (this.__u || '').slice(0, 600), method: this.__m, body: String(body || '').slice(0, 1200), headers: '' });
      }
      return os.apply(this, arguments);
    };
    return 'hooked-all';
  })()`,
  returnByValue: true,
});
console.log('CAPTURE READY — 请现在在抖音页面回复一条评论');
// 保持连接 10 分钟
await new Promise(r => setTimeout(r, 10 * 60 * 1000));
ws.close();
