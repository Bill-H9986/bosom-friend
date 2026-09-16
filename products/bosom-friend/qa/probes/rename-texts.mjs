import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const roots = [
  'C:/Users/Jay/Desktop/Bosom friend APP/apps/zhiyin/project/bosom-friend-web/src',
  'C:/Users/Jay/Desktop/Bosom friend APP/apps/zhiyin/project/bosom-friend-electron/src',
  'C:/Users/Jay/Desktop/Bosom friend APP/apps/zhiyin/project/bosom-friend-electron/electron',
];
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules', 'dist', 'dist-electron'].includes(n)) continue; walk(f); } else if (/\.(ts|tsx|json|html)$/.test(n)) files.push(f); } })(roots[0]);
(function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules', 'dist', 'dist-electron'].includes(n)) continue; walk(f); } else if (/\.(ts|tsx|json|html)$/.test(n)) files.push(f); } })(roots[1]);
(function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules', 'dist', 'dist-electron'].includes(n)) continue; walk(f); } else if (/\.(ts|tsx|json|html)$/.test(n)) files.push(f); } })(roots[2]);
let changed = 0;
for (const f of files) {
  let src = readFileSync(f, 'utf8');
  const before = src;
  // 仅品牌文案/注释：中文“知音”与拼音 ZhiYin；协议名（__ZHIYIN_AUTH_TOKEN__/zhiyin-agent-session/zhiyin:*/ZhiyinPlugin）不在替换清单内
  src = src.replace(/知音/g, 'Bosom Friend');
  src = src.replace(/ZhiYin/g, 'Bosom Friend');
  if (src !== before) { writeFileSync(f, src, 'utf8'); changed++; }
}
console.log('brand texts changed: ' + changed);