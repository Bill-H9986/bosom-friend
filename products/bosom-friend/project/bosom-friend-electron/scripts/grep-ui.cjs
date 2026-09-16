const fs = require('fs');
const lines = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/dyim/web_scraper.py', 'utf8').split('\n');
for (const pat of ['USER_INFO_API', 'sec_user_ids', 'im/user/info', 'sender_sec_uid', 'resolve_sender']) {
  console.log('\n=== ' + pat);
  lines.forEach((l, i) => { if (l.includes(pat)) console.log((i + 1) + ': ' + l.trim().slice(0, 160)); });
}
