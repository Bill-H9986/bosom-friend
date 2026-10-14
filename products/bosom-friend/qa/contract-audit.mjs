// 契约审计：前端调用 URL 与后端注册路由逐段比对（无引号转义陷阱版）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// 退出码（2026-10-12 收敛，见 task-8）：有 UNMATCHED、或源码读不到 → 1；真全绿才 0。
// 负向对照：CONTRACT_AUDIT_ROOT 指向不存在的目录 → 必须退出码 1。
const root = process.env.CONTRACT_AUDIT_ROOT ?? 'C:/Users/Jay/Desktop/Bosom friend APP';
const webSrc = root + '/products/bosom-friend/project/bosom-friend-web/src';
const backendSrc = root + '/products/bosom-friend/server/src';
function walk(dir, out) { for (const name of readdirSync(dir)) { const full = join(dir, name); const st = statSync(full); if (st.isDirectory()) walk(full, out); else if (/\.(ts|tsx)$/.test(name)) out.push(full); } return out; }
let files = [];
try { files = walk(webSrc, []) } catch (e) {
  console.log('CONTRACT_AUDIT_FAIL 读不到前端源码：' + webSrc + '（' + String(e.message).slice(0, 120) + '）');
  process.exit(1);
}
const frontend = new Set();
const BT = String.fromCharCode(96);
for (const f of files) { const src = readFileSync(f, 'utf8'); const re = /http\.(get|post|put|patch|delete)<[^>]*>\s*\(/g; let m; while ((m = re.exec(src)) !== null) { let i = re.lastIndex; while (i < src.length && ' \t\r\n'.includes(src[i])) i++; const q = src[i]; if (q !== '"' && q !== String.fromCharCode(39) && q !== BT) continue; const start = i + 1; let j = start; while (j < src.length && src[j] !== q) j++; const path = src.slice(start, j); if (path.length && !path.includes('${')) frontend.add(path.trim()); } }
// 后端路由不只住在 3 个文件里：api.ts 已冻结增长，路由陆续搬到 routes-*.ts，
// 只扫 3 个文件会把搬出去的路由全报成 UNMATCHED（2026-10-12 实测 12 条假 UNMATCHED，差点变成常驻红灯）。
const backFiles = walk(backendSrc, []);
const routes = [];
for (const f of backFiles) { let src = ''; try { src = readFileSync(f, 'utf8') } catch (e) { console.log('CONTRACT_AUDIT_FAIL 读不到后端路由文件 ' + f + '：' + String(e.message).slice(0, 120)); process.exit(1) } let m; const routeRe = /p: '([^']+)'/g; while ((m = routeRe.exec(src)) !== null) routes.push(m[1]); }
function match(p) { if (p.endsWith('/')) return routes.some(r => r.startsWith(p)); const segs = p.split('/').filter(x => x !== ''); const tpl = segs.map(x => (x.includes('${') ? ':x' : x)); return routes.some(r => { const rt = r.split('/').filter(Boolean); if (rt.length !== tpl.length) return false; for (let i = 0; i < rt.length; i++) { if (rt[i].startsWith(':') || rt[i] === tpl[i]) continue; return false; } return true; }); }
const unmatched = [...frontend].filter(p => !match(p));
console.log('frontend literal urls: ' + frontend.size);
console.log('backend routes: ' + routes.length);
console.log('');
console.log('=== UNMATCHED (' + unmatched.length + ') ===');
for (const u of unmatched) console.log('  ' + u);
console.log('');
if (unmatched.length > 0) {
  console.log('CONTRACT_AUDIT_FAIL ' + unmatched.length + ' 个前端字面量调用在后端找不到对应路由');
  process.exitCode = 1;
} else {
  console.log('CONTRACT_AUDIT_OK 前端 ' + frontend.size + ' 个字面量调用全部有后端路由');
  process.exitCode = 0;
}