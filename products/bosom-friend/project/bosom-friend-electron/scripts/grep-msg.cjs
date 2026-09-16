const fs = require('fs');
const dir = 'C:/Users/Jay/AppData/Local/Temp/msgchunk';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
for (const pat of ['user_message', 'im/', 'conversation', 'send', 'message/list', 'private', '私信']) {
  console.log('\n########## PAT: ' + pat);
  for (const f of files) {
    const s = fs.readFileSync(dir + '/' + f, 'utf8');
    const re = new RegExp('.{0,70}' + pat + '.{0,110}', 'gi');
    const hits = [...s.matchAll(re)].slice(0, 6);
    if (hits.length) {
      console.log('--- ' + f);
      console.log(hits.map(m => m[0].replace(/\n/g, ' ')).join('\n'));
    }
  }
}
