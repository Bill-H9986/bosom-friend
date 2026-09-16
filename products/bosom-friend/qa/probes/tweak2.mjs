import { readFileSync, writeFileSync } from 'node:fs';
const f = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/smoke-all.mjs';
let src = readFileSync(f, 'utf8');
src = src.replace('setTimeout(r, 4000));', 'setTimeout(r, 6000));');
writeFileSync(f, src, 'utf8');
console.log('wait -> 6s');