// 装配层与测试资产品牌替换。
import { readFileSync, writeFileSync } from 'node:fs';
const P = 'C:/Users/Jay/Desktop/Bosom friend APP';
const files = [
  P + '/packages/bundle/opc-app/cordis.patch.yml',
  P + '/packages/bundle/opc-app/package.json',
  P + '/packages/bundle/opc-app/tsconfig.json',
  P + '/apps/opc/package.json',
  P + '/apps/cli/package.json',
];
const globLinks = [
  P + '/apps/zhiyin/README.md',
  P + '/apps/zhiyin/TEST_REPORT.md',
];
const scripts = [
  'smoke-all.mjs', 'smoke-edge.mjs', 'smoke-sse.mjs', 'smoke-api.ps1', 'raw-sse.mjs', 'contract-audit.mjs', 'pw-check.mjs', 'pw-final2.mjs', 'pw-nav2.mjs'
];
const all = [...files, ...globLinks, ...scripts.map(n => P + '/apps/zhiyin/' + n)];
for (const f of all) {
  try {
    let src = readFileSync(f, 'utf8');
    const before = src;
    src = src.replace(/dsh-zhiyin-server/g, 'dsh-bosom-friend-server');
    src = src.replace(/zhiyin-server/g, 'bosom-friend-server');
    src = src.replace(/packages\/zhiyin/g, 'packages/bosom-friend');
    src = src.replace(/zhiyin\/zhiyin-server/g, 'bosom-friend/bosom-friend-server');
    src = src.replace(/\/zhiyin\//g, '/bosom-friend/');
    src = src.replace(/zhiyin\/api/g, 'bosom-friend/api');
    src = src.replace(/\.dsh\/zhiyin/g, '.dsh/bosom-friend');
    src = src.replace(/dshHomePath\('zhiyin'\)/g, "dshHomePath('bosom-friend')");
    src = src.replace(/aitoearn-electron/g, 'bosom-friend-electron');
    src = src.replace(/aitoearn-web/g, 'bosom-friend-web');
    if (src !== before) { writeFileSync(f, src, 'utf8'); console.log('changed ' + f.split(P + '/').pop()); }
  } catch (e) { console.log('skip ' + f); }
}