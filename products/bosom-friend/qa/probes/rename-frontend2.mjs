import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/zhiyin/project/bosom-friend-electron';
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules', 'dist', 'dist-electron', 'release'].includes(n)) continue; walk(f); } else if (/\.[jt]sx?$/.test(n)) files.push(f); } })(root);
let changed = 0;
for (const f of files) {
  let src = readFileSync(f, 'utf8');
  const before = src;
  src = src.replace(/zhiyin-harness/g, 'bosom-friend-harness');
  if (src !== before) { writeFileSync(f, src, 'utf8'); changed++; }
}
const vf = root + '/vite.config.mts';
let v = readFileSync(vf, 'utf8');
const vb = v;
v = v.replace(/..\/aitoearn-web\/src/g, '../bosom-friend-web/src');
v = v.replace(/..\/aitoearn-web/g, '../bosom-friend-web');
if (v !== vb) writeFileSync(vf, v, 'utf8');
const tf = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/zhiyin/project/bosom-friend-web/tsconfig.json';
let t = readFileSync(tf, 'utf8');
t = t.replace(/..\/aitoearn-electron\/tsconfig.json/g, '../bosom-friend-electron/tsconfig.json');
writeFileSync(tf, t, 'utf8');
console.log('harness refs changed: ' + changed + '; configs updated');