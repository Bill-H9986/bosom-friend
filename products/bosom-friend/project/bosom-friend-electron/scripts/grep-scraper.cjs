const fs = require('fs');
const s = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/dyim/web_scraper.py', 'utf8');
const lines = s.split('\n');
console.log('LINES', lines.length);
for (const pat of ['def ', 'http', 'imapi', 'conversation', 'message', 'send', 'protobuf', 'base64', 'a_bogus', 'session', 'host']) {
  const hits = [];
  lines.forEach((l, i) => { if (l.toLowerCase().includes(pat.toLowerCase())) hits.push((i + 1) + ': ' + l.trim().slice(0, 140)); });
  console.log('\n=== ' + pat + ' (' + hits.length + ')');
  console.log(hits.slice(0, 20).join('\n'));
}
