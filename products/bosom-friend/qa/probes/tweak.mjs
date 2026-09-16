import { readFileSync, writeFileSync } from 'node:fs';
const f = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/smoke-all.mjs';
let src = readFileSync(f, 'utf8');
src = src.replace("await new Promise(r => setTimeout(r, 2200));", "await new Promise(r => setTimeout(r, 4000));");
writeFileSync(f, src, 'utf8');
console.log('wait extended');