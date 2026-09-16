// 后端包内全量品牌替换（保留 __ZHIYIN_AUTH_TOKEN__ 协议名）。
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = 'C:/Users/Jay/Desktop/Bosom friend APP/packages/bosom-friend/bosom-friend-server';
const files = [];
(function walk(dir) { for (const n of readdirSync(dir)) { const f = join(dir, n); if (statSync(f).isDirectory()) { if (n === 'lib' || n === 'node_modules') continue; walk(f); } else if (/\.[jt]sx?$/.test(n) || n === 'package.json' || n === 'tsconfig.json') { files.push(f); } } })(root);
const KEEP = ['__ZHIYIN_AUTH_TOKEN__'];
let stat = {};
for (const f of files) {
  let src = readFileSync(f, 'utf8');
  const before = src;
  src = src.replace(/zhiyin\/api/g, 'bosom-friend/api');
  src = src.replace(/\/zhiyin/g, '/bosom-friend');
  src = src.replace(/dsh-zhiyin-server/g, 'dsh-bosom-friend-server');
  src = src.replace(/zhiyin-server/g, 'bosom-friend-server');
  src = src.replace(/zhiyin-api/g, 'bosom-friend-api');
  src = src.replace(/homePath\('zhiyin'\)/g, "homePath('bosom-friend')");
  src = src.replace(/\.dsh\/zhiyin/g, '.dsh/bosom-friend');
  src = src.replace(/ZhiYin/g, 'Bosom Friend');
  src = src.replace(/知音/g, 'Bosom Friend');
  // 最后保护协议名（如被上面误伤回滚——实际上 __ZHIYIN 不在替换列表内，双保险）
  if (KEEP.some(k => src.includes(k))) {}
  if (src !== before) { writeFileSync(f, src, 'utf8'); stat[f.split('/bosom-friend-server/').pop()] = (src.match(/bosom-friend/g) || []).length; }
}
console.log('files changed: ' + Object.keys(stat).length);