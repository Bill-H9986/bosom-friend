const fs = require('fs');
const dir = 'C:/Users/Jay/AppData/Local/Temp/msgchunk';
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
  const s = fs.readFileSync(dir + '/' + f, 'utf8');
  for (const pat of ['type:O', 'O=', 'reply', 'comment/list', 'comment/reply', 'user_comment', 'interaction', 'at_me', 'mention', 'dm_']) {
    const re = new RegExp('.{0,80}' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.{0,100}', 'gi');
    const hits = [...s.matchAll(re)].slice(0, 5);
    if (hits.length) { console.log('\n=== ' + f + ' | ' + pat); console.log(hits.map(m => m[0].replace(/\n/g,' ')).join('\n')); }
  }
}
