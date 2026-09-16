const fs = require('fs');
const s = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/creator-main.js', 'utf8');
for (const pat of ['douyin_creator_pc_', 'activeWhen:"/', 'entry:"/goofy/']) {
  const re = new RegExp('.{0,20}' + pat + '.{0,120}', 'g');
  const hits = [...s.matchAll(re)].slice(0, 60);
  console.log('=== ' + pat + ' (' + hits.length + ')');
  console.log(hits.map(m => m[0].replace(/\n/g,' ')).join('\n'));
}
