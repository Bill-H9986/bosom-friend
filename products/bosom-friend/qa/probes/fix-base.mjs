import { readFileSync, writeFileSync } from 'node:fs';
const P = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend';
for (const n of ['smoke-all.mjs', 'smoke-edge.mjs', 'raw-sse.mjs', 'smoke-api.ps1', 'contract-audit.mjs', 'smoke-sse.mjs']) {
  try { const f = P + '/' + n; let src = readFileSync(f, 'utf8'); const before = src;
  src = src.replace(/127\.0\.0\.1:3090/g, '127.0.0.1:3081').replace(/http:\/\/127\.0\.0\.1:3090/g, 'http://127.0.0.1:3081');
  if (src !== before) { writeFileSync(f, src, 'utf8'); console.log('base fixed: ' + n); }
  } catch (e) { console.log('skip ' + n); }
}