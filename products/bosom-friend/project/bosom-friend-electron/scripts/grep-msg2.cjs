const fs = require('fs');
const f = 'C:/Users/Jay/AppData/Local/Temp/msgchunk/message.032ceed6.js';
const s = fs.readFileSync(f, 'utf8');
for (const pat of ['biz_types', 'count:15', 'cursor', 'type:', 'list(', 'batch_read', 'is_read', 'dm', 'comment', 'notice']) {
  const re = new RegExp('.{0,90}' + pat + '.{0,130}', 'gi');
  const hits = [...s.matchAll(re)].slice(0, 8);
  if (hits.length) { console.log('\n=== ' + pat + ' (' + hits.length + ')'); console.log(hits.map(m => m[0].replace(/\n/g,' ')).join('\n')); }
}
