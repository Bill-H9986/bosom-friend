import { readFileSync, writeFileSync } from 'node:fs';
const dirs = ['C:/Users/Jay/Desktop/Bosom friend APP/apps/zhiyin/project/bosom-friend-electron'];
const files = [];
(function walk(d){ require('node:fs').readdirSync(d).forEach(n=>{ const f=require('node:path').join(d,n); const st=require('node:fs').statSync(f); if(st.isDirectory()){ if(n==='node_modules'||n==='dist'||n==='dist-electron'||n==='release')return; walk(f);} else if(/\.[jt]sx?$/.test(n)) files.push(f);})})(dirs[0]);
const fs = require('node:fs'); const path = require('node:path');
for (const f of files) {
  let src = fs.readFileSync(f, 'utf8');
  const before = src;
  src = src.replace(/zhiyin-harness/g, 'bosom-friend-harness');
  if (src !== before) { fs.writeFileSync(f, src, 'utf8'); console.log('ref updated: ' + f.split('bosom-friend-electron/').pop()); }
}
// 配置文件：vite alias @web 与 tsconfig extends、fs.allow
const vf = dirs[0] + '/vite.config.mts';
let v = fs.readFileSync(vf, 'utf8');
const vb = v;
v = v.replace(/..\/aitoearn-web\/src/g, '../bosom-friend-web/src');
v = v.replace(/..\/aitoearn-web/g, '../bosom-friend-web');
if (v !== vb) fs.writeFileSync(vf, v, 'utf8');
const tf = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/zhiyin/project/bosom-friend-web/tsconfig.json';
let t = fs.readFileSync(tf, 'utf8');
t = t.replace(/..\/aitoearn-electron\/tsconfig.json/g, '../bosom-friend-electron/tsconfig.json');
fs.writeFileSync(tf, t, 'utf8');
console.log('configs updated');