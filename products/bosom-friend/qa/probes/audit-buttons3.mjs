import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const roots = [
  'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-web/src',
  'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-electron/src',
];
const files = [];
for (const root of roots) {
  (function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules', 'dist', 'dist-electron'].includes(n)) continue; walk(f); } else if (/\.tsx$/.test(n)) files.push(f); } })(root);
}
const suspicious = [];
let total = 0, action = 0, disabled = 0, spread = 0;
const re = /<(button|Button)\b([^>]*?)(\/?)>/g;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[2];
    const line = src.slice(0, m.index).split(/\n/).length;
    total++;
    if (/disabled/.test(attrs)) { disabled++; continue; }
    if (/onClick|onPress|onSubmit|onMouseDown|href=|asChild|type=["']submit["']|role=["']combobox["']|\.\.\./.test(attrs)) { action++; continue; }
    suspicious.push(f.split('/src/').pop() + ':' + line);
  }
}
console.log('total=' + total + ' action=' + action + ' disabled=' + disabled);
console.log('TRUE suspicious: ' + suspicious.length);
for (const x of suspicious) console.log('  ' + x);