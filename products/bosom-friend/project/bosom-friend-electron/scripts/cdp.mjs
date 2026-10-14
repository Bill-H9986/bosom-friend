// 知音 CDP 界面测试驱动：node cdp.mjs '<JS表达式>' [--target <url片段>]
// 表达式在页面主世界执行，支持 await；返回 JSON 到 stdout
import { execSync } from 'node:child_process';
import WebSocket from 'ws';

const port = 9223;
const exprIdx = process.argv.indexOf('--expr');
const expr = exprIdx >= 0 ? process.argv[exprIdx + 1] : 'document.title';
const tgtFilter = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : '';

const list = JSON.parse(execSync(`curl -s http://127.0.0.1:${port}/json/list`, { encoding: 'utf8' }));
let targets = list.filter(t => t.type === 'page');
if (tgtFilter) targets = targets.filter(t => (t.url + t.title).includes(tgtFilter));
if (!targets.length) { console.log(JSON.stringify({ error: 'no-target', available: list.map(t => ({ type: t.type, url: t.url.slice(0, 60), title: t.title.slice(0, 30) })) })); process.exit(1); }
const tgt = targets[0];

const ws = new WebSocket(tgt.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

const result = await new Promise((res) => {
  const payload = JSON.stringify({
    id: 1, method: 'Runtime.evaluate',
    params: { expression: expr, awaitPromise: true, returnByValue: true },
  });
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.id === 1) res(m.result); });
  ws.send(payload);
  setTimeout(() => res({ error: 'timeout-15s' }), 15000);
});
ws.close();
console.log(JSON.stringify(result.result?.result?.value ?? result, null, 1));
