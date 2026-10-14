const fs = require('fs');
const s = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/creator-main.js', 'utf8');
for (const pat of ['manifest', 'user_message', 'getUserMessage', 'message/', 'chunk-map', 'chunkMap', 'route']) {
  const m = [...s.matchAll(new RegExp('.{0,80}' + pat + '.{0,120}', 'gi'))].slice(0, 10);
  console.log('=== ' + pat + ' (' + m.length + ')');
  console.log(m.map(x => x[0].replace(/\n/g, ' ')).join('\n'));
}
