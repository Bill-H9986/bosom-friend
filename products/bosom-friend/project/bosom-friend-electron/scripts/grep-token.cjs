const fs = require('fs');
const s = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/dyim/TokenConfig.java', 'utf8');
const lines = s.split('\n');
console.log('LINES', lines.length);
for (const pat of ['identity_security', 'ticket', 'ts_sign', 'token', 'refresh', 'expire', 'createFromYourConfig', 'genRealMsToken', 'http', 'url']) {
  const hits = [];
  lines.forEach((l, i) => { if (l.toLowerCase().includes(pat.toLowerCase())) hits.push((i + 1) + ': ' + l.trim().slice(0, 130)); });
  console.log('\n=== ' + pat + ' (' + hits.length + ')');
  console.log(hits.slice(0, 18).join('\n'));
}
