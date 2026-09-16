// settle 验证：31281 单实例上任务能否正常落终态（对照 31280 的挂起现象）
const base = 'http://127.0.0.1:31281';
const login = async () => (await fetch(base + '/bosom-friend/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456' }) })).json();
let r = await login();
if (r.code !== 0) {
  await fetch(base + '/bosom-friend/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456', name: 'QA' }) });
  r = await login();
}
const H = { Authorization: 'Bearer ' + r.data.token, 'content-type': 'application/json' };
const c = await (await fetch(base + '/bosom-friend/api/ai/draft-generation/v2', { method: 'POST', headers: H, body: JSON.stringify({ quantity: 1, groupId: 'mg-persist', model: 'zy-template-video', prompt: '晨跑' }) })).json();
const out = ['create: ' + JSON.stringify(c)];
const ids = c.data.taskIds;
const t0 = Date.now();
let final = null;
for (let i = 0; i < 48; i++) {
  await new Promise(rr => setTimeout(rr, 5000));
  const q = await (await fetch(base + '/bosom-friend/api/ai/draft-generation/query', { method: 'POST', headers: H, body: JSON.stringify({ taskIds: ids }) })).json();
  const sts = q.data.map(t => t.status).join(',');
  out.push(`poll ${Math.round((Date.now() - t0) / 1000)}s status=${sts}`);
  if (q.data.every(t => t.status !== 'generating')) { final = q; break; }
}
out.push('final: ' + (final ? JSON.stringify(final).slice(0, 900) : 'STILL GENERATING after 240s'));
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./.qa-probe-settle-31281.out.txt', import.meta.url), out.join('\n'), 'utf8');
console.log('DONE');
