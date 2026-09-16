const { app } = require('electron');
const Database = require('C:/Users/Jay/Desktop/AiToEarn-main/project/aitoearn-electron/node_modules/better-sqlite3');
app.whenReady().then(() => {
  try {
    const db = new Database('C:/Users/Jay/AppData/Roaming/aiToEarn/database.sqlite', { readonly: true });
    const acc = db.prepare("SELECT id, type, uid, nickname, account, loginCookie FROM account").all();
    for (const a of acc) {
      let cookies = [];
      try { cookies = JSON.parse(a.loginCookie); } catch {}
      const domains = [...new Set(cookies.map(c => c.domain))];
      const names = cookies.map(c => c.name);
      console.log('ACCOUNT', a.id, a.type, a.nickname, a.uid, 'cookieCount=' + cookies.length);
      console.log('DOMAINS=' + JSON.stringify(domains));
      console.log('NAMES=' + JSON.stringify(names));
      const sess = cookies.filter(c => /sessionid|sid_tt|sessionid_ss|passport/.test(c.name));
      console.log('SESSION_COOKIES=' + JSON.stringify(sess.map(c => ({name:c.name, domain:c.domain, val:(c.value||'').slice(0,20)}))));
    }
  } catch (e) { console.error('ERR', e); }
  app.exit(0);
});
