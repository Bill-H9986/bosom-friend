import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const roots = ['C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project', 'C:/Users/Jay/Desktop/Bosom friend APP/packages/bosom-friend/bosom-friend-server', 'C:/Users/Jay/Desktop/Bosom friend APP/apps/opc', 'C:/Users/Jay/Desktop/Bosom friend APP/packages/bundle/opc-app'];
const files = [];
for (const root of roots) {
  (function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules', 'dist', 'dist-electron', 'release', 'lib', '.git'].includes(n)) continue; walk(f); } else { files.push(f); } } })(root);
}
let fixed = 0;
for (const f of files) {
  const buf = readFileSync(f);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    writeFileSync(f, buf.subarray(3));
    fixed++;
  }
}
console.log('BOM stripped: ' + fixed);