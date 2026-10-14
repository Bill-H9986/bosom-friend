const { app } = require('electron');
const Database = require('C:/Users/Jay/Desktop/AiToEarn-main/project/aitoearn-electron/node_modules/better-sqlite3');
app.whenReady().then(() => {
  try {
    const db = new Database('C:/Users/Jay/AppData/Roaming/aiToEarn/database.sqlite', { readonly: true });
    console.log('DM_RECORDS=' + JSON.stringify(db.prepare('SELECT id, accountId, conversationShortId, senderName, message, reply, status, createTime FROM dmReplyRecord ORDER BY id DESC LIMIT 10').all(), null, 1));
  } catch (e) { console.error('ERR', e); }
  app.exit(0);
});
