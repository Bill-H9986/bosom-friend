// 原生字节抓流：验证 SSE 字节层面的事件序列。
import { writeFileSync } from 'node:fs';
const base = 'http://127.0.0.1:3080';
const loginRes = await fetch(base + '/bosom-friend/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456' }) })
let loginData = await loginRes.json()
if (loginData.code !== 0) {
  await fetch(base + '/bosom-friend/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456', name: 'QA' }) })
  loginData = await (await fetch(base + '/bosom-friend/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456' }) })).json()
}
const r = await fetch(base + '/bosom-friend/api/agent/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer ' + loginData.data.token },
  body: JSON.stringify({ prompt: '写一段关于晨跑的短文', includePartialMessages: true }),
});
const reader = r.body.getReader();
const dec = new TextDecoder();
let raw = '';
const t0 = Date.now();
const outFile = process.argv[2] ?? 'sse-raw.txt';
while (Date.now() - t0 < 30000) {
  const { value, done } = await reader.read();
  if (done) break;
  raw += dec.decode(value, { stream: true });
}
writeFileSync(outFile, raw, 'utf8');
const types = [...raw.matchAll(/"type":"([a-z_]+)"/g)].map(m => m[1]);
console.log('bytes=' + raw.length + ' types=' + JSON.stringify(types));
console.log('has_done=' + raw.includes('"type":"done"'));
