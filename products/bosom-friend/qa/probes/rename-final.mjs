import { readdirSync, statSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const E = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-electron';
const W = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-web';
// 0) 删日志
rmSync(E + '/zhiyin-dev.log.err', { force: true });
// 1) kernel-host 改名 + 引用/函数名/字符串同步
renameSync(E + '/electron/main/zhiyin-kernel-host.ts', E + '/electron/main/bosom-friend-kernel-host.ts');
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules', 'dist', 'dist-electron'].includes(n)) continue; walk(f); } else if (/\.(ts|tsx)$/.test(n) && !n.endsWith('.bak')) files.push(f); } })(E);
for (const f of files) {
  let src = readFileSync(f, 'utf8'); const before = src;
  src = src.replace(/zhiyin-kernel-host/g, 'bosom-friend-kernel-host');
  src = src.replace(/startZhiyinKernelHost/g, 'startBosomFriendKernelHost');
  src = src.replace(/zhiyin-harness\.json/g, 'bosom-friend-harness.json');
  if (src !== before) writeFileSync(f, src, 'utf8');
}
rmSync(E + '/electron/main/zhiyin/legacy-decision.ts.bak-v011', { force: true });
console.log('kernel host renamed');
// 2) logo / d.ts
renameSync(E + '/public/assets/zhiyin-logo.svg', E + '/public/assets/bosom-friend-logo.svg');
renameSync(E + '/src/assets/zhiyin-logo.svg', E + '/src/assets/bosom-friend-logo.svg');
renameSync(E + '/src/type/zhiyin-harness.d.ts', E + '/src/type/bosom-friend-harness.d.ts');
console.log('assets renamed');
// 3) zhiyinAssistant → bosomFriendAssistant（web）
renameSync(W + '/src/utils/zhiyinAssistant.ts', W + '/src/utils/bosomFriendAssistant.ts');
const files2 = [];
(function walk2(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules', 'dist', 'dist-electron'].includes(n)) continue; walk2(f); } else if (/\.(ts|tsx)$/.test(n)) files2.push(f); } })(W + '/src');
let refs = 0;
for (const f of files2) {
  let src = readFileSync(f, 'utf8'); const before = src;
  src = src.replace(/zhiyinAssistant/g, 'bosomFriendAssistant');
  if (src !== before) { writeFileSync(f, src, 'utf8'); refs++; }
}
console.log('web refs updated: ' + refs);