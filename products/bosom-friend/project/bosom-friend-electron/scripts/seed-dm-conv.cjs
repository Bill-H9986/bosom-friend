const { app } = require('electron');
const Database = require('C:/Users/Jay/Desktop/AiToEarn-main/project/aitoearn-electron/node_modules/better-sqlite3');
app.whenReady().then(() => {
  try {
    const db = new Database('C:/Users/Jay/AppData/Roaming/aiToEarn/database.sqlite');
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dmConversation'").get();
    if (!exists) { console.log('TABLE_NOT_EXISTS'); app.exit(0); return; }
    const row = db.prepare("SELECT * FROM dmConversation WHERE accountId=1 AND conversationShortId='7672290885698159141'").get();
    if (row) { console.log('ALREADY_SEEDED'); app.exit(0); return; }
    db.prepare("INSERT INTO dmConversation (accountId, conversationId, conversationShortId, createTime, updateTime) VALUES (?, ?, ?, ?, ?)").run(
      1, '0:1:98478746276:744786308115968', '7672290885698159141', new Date().toISOString().slice(0,19).replace('T',' '), new Date().toISOString().slice(0,19).replace('T',' ')
    );
    console.log('SEEDED');
  } catch (e) { console.error('ERR', e); }
  app.exit(0);
});
