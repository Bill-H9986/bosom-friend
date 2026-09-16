const fs = require('fs');
const s = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/dyim/MessageSender.java', 'utf8');
console.log('LEN', s.length);
const lines = s.split('\n');
console.log('LINES', lines.length);
// find endpoint paths
for (const pat of ['imapi', 'http', 'POST', 'send', 'createConversation', 'sendMsg2Stranger', 'a_bogus', 'base64', 'Content']) {
  const idxs = [];
  lines.forEach((l, i) => { if (l.includes(pat)) idxs.push(i + 1); });
  console.log(pat, 'lines:', idxs.slice(0, 15).join(','));
}
