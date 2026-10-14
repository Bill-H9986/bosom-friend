const fs = require('fs');
const lines = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/dyim/web_scraper.py', 'utf8').split('\n');
for (const pat of ['has_im_module', 'IM SDK', 'imModule', 'window.api', 'api.im', 'clear_im', 'IM_CACHE', 'localStorage', 'navigate_to_chat']) {
  console.log('\n=== ' + pat);
  lines.forEach((l, i) => { if (l.includes(pat)) console.log((i + 1) + ': ' + l.trim().slice(0, 180)); });
}
