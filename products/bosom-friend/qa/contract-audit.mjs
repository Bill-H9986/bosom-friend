// 契约审计：前端调用 URL 与后端注册路由逐段比对（无引号转义陷阱版）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const root = 'C:/Users/Jay/Desktop/Bosom friend APP';
const webSrc = root + '/products/bosom-friend/project/bosom-friend-web/src';
const backendSrc = root + '/products/bosom-friend/server/src';
function walk(dir, out) { for (const name of readdirSync(dir)) { const full = join(dir, name); const st = statSync(full); if (st.isDirectory()) walk(full, out); else if (/\.(ts|tsx)$/.test(name)) out.push(full); } return out; }
const files = walk(webSrc, []);
const frontend = new Set();
const BT = String.fromCharCode(96);
for (const f of files) { const src = readFileSync(f, 'utf8'); const re = /http\.(get|post|put|patch|delete)<[^>]*>\s*\(/g; let m; while ((m = re.exec(src)) !== null) { let i = re.lastIndex; while (i < src.length && ' \t\r\n'.includes(src[i])) i++; const q = src[i]; if (q !== '"' && q !== String.fromCharCode(39) && q !== BT) continue; const start = i + 1; let j = start; while (j < src.length && src[j] !== q) j++; const path = src.slice(start, j); if (path.length && !path.includes('${')) frontend.add(path.trim()); } }
const backFiles = ['api.ts', 'routes-channels.ts', 'routes-content.ts'].map(n => backendSrc + '/' + n);
const routes = [];
for (const f of backFiles) { const src = readFileSync(f, 'utf8'); let m; const routeRe = /p: '([^']+)'/g; while ((m = routeRe.exec(src)) !== null) routes.push(m[1]); }
function match(p) { const segs = p.split('/').filter(x => x !== ''); const tpl = segs.map(x => (x.includes('${') ? ':x' : x)); return routes.some(r => { const rt = r.split('/').filter(Boolean); if (rt.length !== tpl.length) return false; for (let i = 0; i < rt.length; i++) { if (rt[i].startsWith(':') || rt[i] === tpl[i]) continue; return false; } return true; }); }
const unmatched = [...frontend].filter(p => !match(p));
console.log('frontend literal urls: ' + frontend.size);
console.log('backend routes: ' + routes.length);
console.log('');
console.log('=== UNMATCHED (' + unmatched.length + ') ===');
for (const u of unmatched) console.log('  ' + u);