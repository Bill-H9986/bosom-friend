import { readFileSync, writeFileSync } from 'node:fs';
const P = 'C:/Users/Jay/Desktop/Bosom friend APP';
const files = [ P + '/start-opc.cmd', P + '/start-dsh.cmd', P + '/部署说明.md', P + '/项目整理清单.md' ];
for (const f of files) {
  try { let src = readFileSync(f, 'utf8'); const before = src;
  src = src.replace(/\[zhiyin\]/g, '[bosom-friend]');
  src = src.replace(/zhiyin\/zhiyin-server/g, 'bosom-friend/bosom-friend-server');
  src = src.replace(/packages\/zhiyin/g, 'packages/bosom-friend');
  src = src.replace(/apps\/zhiyin/g, 'apps/bosom-friend');
  src = src.replace(/\/zhiyin\/api/g, '/bosom-friend/api');
  src = src.replace(/\/zhiyin\//g, '/bosom-friend/');
  src = src.replace(/\.dsh\/zhiyin/g, '.dsh/bosom-friend');
  src = src.replace(/aitoearn-/g, 'bosom-friend-');
  src = src.replace(/知音/g, 'Bosom Friend');
  if (src !== before) { writeFileSync(f, src, 'utf8'); console.log('updated ' + f.split(P + '/').pop()); }
  } catch (e) { console.log('skip ' + f); }
}
// harness 包名
const hf = P + '/apps/zhiyin/project/bosom-friend-harness/package.json';
let h = readFileSync(hf, 'utf8');
h = h.replace(/zhiyin-harness/g, 'bosom-friend-harness');
writeFileSync(hf, h, 'utf8');
console.log('harness pkg ok');