// 逐项定案探针：6 个 FAIL 的真实契约采样（目标 31280 共用实例）
const base = (process.env.BF_QA_ORIGIN || 'http://127.0.0.1:31280').replace(/\/+$/, '');
const out = [];
const log = (...a) => { out.push(a.join(' ')); };
async function ensureToken() {
  const login = async () => (await fetch(base + '/bosom-friend/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456' }) })).json();
  let r = await login();
  if (r.code !== 0) {
    await fetch(base + '/bosom-friend/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456', name: 'QA' }) });
    r = await login();
  }
  return r.data.token;
}
const H = { Authorization: 'Bearer ' + await ensureToken(), 'content-type': 'application/json' };
async function j(method, path, body) {
  const r = await fetch(base + '/bosom-friend/api/' + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return [r.status, await r.json()];
}
function brief(x, n = 600) { return JSON.stringify(x).slice(0, n); }

// 1. draft settle：创建 1 个任务并最长轮询 240s，观察状态机走到哪
{
  const [, c] = await j('POST', 'ai/draft-generation/v2', { quantity: 1, groupId: 'mg-persist', model: 'zy-template-video', prompt: '晨跑' });
  log('## 1 draft-generation/v2 create:', brief(c));
  const ids = c.data.taskIds;
  const t0 = Date.now();
  let settled = null, last = null;
  for (let i = 0; i < 48; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const [, q] = await j('POST', 'ai/draft-generation/query', { taskIds: ids });
    last = q;
    const sts = q.data.map(t => t.status).join(',');
    log(`poll ${Math.round((Date.now() - t0) / 1000)}s status=${sts}`);
    if (q.data.every(t => t.status !== 'generating')) { settled = q; break; }
  }
  log('## 1 draft settle final:', settled ? brief(settled, 1500) : 'STILL GENERATING after 240s: ' + brief(last, 1500));
}

// 2. douyin searchTopic
{
  const [s, r] = await j('POST', 'statistics/channels/douyin/searchTopic', { topic: '咖啡', language: 'zh-CN' });
  log('## 2 douyin searchTopic:', 'status=' + s, brief(r));
}

// 3. agent-collect（跑两次看稳定性）
for (let k = 0; k < 2; k++) {
  const [s, r] = await j('POST', 'v2/statistics/note-comment-search/agent-collect', { keyword: '咖啡' });
  const d = r.data || {};
  log(`## 3 agent-collect#${k}:`, 'status=' + s, 'code=' + r.code, 'items=' + (d.items || []).length, 'insight=' + JSON.stringify(d.insight).slice(0, 120), 'isSample=' + d.isSample, 'source=' + d.source);
}

// 4. hot feed itemLimit=5 与 =3
for (const lim of [5, 3]) {
  const [s, r] = await j('GET', 'v2/hot-content/sources/weibo/feed?itemLimit=' + lim);
  const d = r.data || {};
  log(`## 4 hot feed itemLimit=${lim}:`, 'status=' + s, 'code=' + r.code, 'items=' + (d.items || []).length, 'freshness=' + d.freshness, 'first=' + brief((d.items || [])[0], 200));
}

// 5. miniapp auth
{
  const [s, r] = await j('POST', 'plat/douyin/miniapp-auth/complete', { taskId: 't1', loginCode: 'x' });
  log('## 5 miniapp auth:', 'status=' + s, brief(r));
}

// 6. work validate
{
  const [s, r] = await j('POST', 'channel/work/validate', { accountId: 'a1', workLink: 'https://www.douyin.com/video/123' });
  log('## 6 work validate:', 'status=' + s, brief(r));
}
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./.qa-probe-fails-31280.out.txt', import.meta.url), out.join('\n'), 'utf8');
console.log('DONE');
