// 前端按钮静态清查：枚举所有 button/Button 元素并分类 handler 绑定。
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const roots = [
  'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-web/src',
  'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-electron/src',
];
const files = [];
for (const root of roots) {
  (function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules', 'dist', 'dist-electron'].includes(n)) continue; walk(f); } else if (/\.(tsx|ts)$/.test(n)) files.push(f); } })(root);
}
const noHandler = [];
const withHandler = [];
const disabled = [];
const skip = new Set(['button', 'submit', 'reset', 'type=submit']);
// 简化处理：统计 button/Button 开标签行
const btnRe = /<([Bb]utton|Button)[^>]*>/g;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let m;
  while ((m = btnRe.exec(src)) !== null) {
    const line = src.slice(0, m.index).split(/\n/).length;
    const tag = m[0];
    const hasHg = /onClick|onPress|onSubmit|onChange/.test(tag) || f.endsWith('.ts');
    const isDisabled = /disabled|Disabled/.test(tag);
    const isTypeSubmit = /type=["']submit["']/.test(tag);
    if (isDisabled && !hasHg) { disabled.push(f.split('/src/').pop() + ':' + line); continue; }
    if (!hasHg && !isTypeSubmit) { noHandler.push(f.split('/src/').pop() + ':' + line + ' :: ' + tag.slice(0, 130)); }
    else { withHandler.push(f.split('/src/').pop() + ':' + line); }
  }
}
console.log('file total: ' + files.length);
console.log('withHandler: ' + withHandler.length);
console.log('disabled: ' + disabled.length);
console.log('NO-HANDLER candidates: ' + noHandler.length);
console.log('--- samples ---');
for (const n of noHandler.slice(0, 60)) console.log('  ' + n);