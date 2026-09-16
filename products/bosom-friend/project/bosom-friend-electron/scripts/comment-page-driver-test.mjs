// 评论页面驱动测试：打开评论管理页 -> 定位评论 -> hover 回复 -> 输入 -> 发送
const CDP = 'http://127.0.0.1:9223';
const targets = await fetch(CDP + '/json/list').then(r => r.json());
const page = targets.find(t => t.type === 'page' && t.url.includes('creator.douyin.com'));
if (!page) { console.error('NO CREATOR PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) { return new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); }); }
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
await new Promise(r => ws.onopen = r);

// 1. 导航到评论管理页
await send('Page.navigate', { url: 'https://creator.douyin.com/creator-micro/interactive/comment?item_id=7672321215972904201' });
await new Promise(r => setTimeout(r, 9000));

// 2. 找所有评论行（含回复按钮的容器）
const expr = `(() => {
  const rows = [...document.querySelectorAll('[class*="comment-item"], [class*="comment-row"], [class*="list-item"]')].filter(el => el.offsetParent !== null);
  const out = rows.map(el => {
    const r = el.getBoundingClientRect();
    const text = (el.textContent || '').trim().slice(0, 30);
    const btns = [...el.querySelectorAll('*')].filter(b => /回复|reply/i.test((b.className||'').toString()) && b.offsetParent !== null).map(b => { const br = b.getBoundingClientRect(); return { x: Math.round(br.x + br.width/2), y: Math.round(br.y + br.height/2), cls: (b.className||'').toString().slice(0, 40) }; });
    return { text, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), btns };
  });
  return JSON.stringify(out);
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log('ROWS', r.result?.value || 'none');
ws.close();
