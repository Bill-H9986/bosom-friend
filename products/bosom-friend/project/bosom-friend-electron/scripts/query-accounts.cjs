const { app } = require('electron');
const Database = require('C:/Users/Jay/Desktop/AiToEarn-main/project/aitoearn-electron/node_modules/better-sqlite3');
app.whenReady().then(() => {
  try {
    const db = new Database('C:/Users/Jay/AppData/Roaming/aiToEarn/database.sqlite', { readonly: true });
    console.log('ACCOUNTS=' + JSON.stringify(db.prepare('SELECT id, userId, type, uid, nickname, status FROM account').all()));
    console.log('USERS=' + JSON.stringify(db.prepare('SELECT * FROM user').all()));
    console.log('TABLES=' + JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%dm%'").all()));
  } catch (e) { console.error('ERR', e); }
  app.exit(0);
});
