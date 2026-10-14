const fs = require('fs');
const f = 'C:/Users/Jay/AppData/Local/Temp/msgchunk/message.032ceed6.js';
const s = fs.readFileSync(f, 'utf8');
// find definition of O used in type:O — look near the tabs/options
const idx = s.indexOf('type:O');
console.log('type:O at', idx);
console.log(s.slice(Math.max(0, idx - 2500), idx + 300));
