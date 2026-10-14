const { app, BrowserWindow, session } = require('electron');
const Database = require('C:/Users/Jay/Desktop/AiToEarn-main/project/aitoearn-electron/node_modules/better-sqlite3');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

app.commandLine.appendSwitch('remote-debugging-port', '9223');

app.whenReady().then(async () => {
  try {
    const db = new Database('C:/Users/Jay/AppData/Roaming/aiToEarn/database.sqlite', { readonly: true });
    const acc = db.prepare('SELECT id, type, loginCookie, nickname FROM account WHERE id = 1').get();
    const cookies = JSON.parse(acc.loginCookie);
    const ses = session.fromPartition('dm-debug');

    for (const c of cookies) {
      const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      const url = 'https://' + domain + (c.path || '/');
      try {
        await ses.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expirationDate: c.expirationDate,
        });
      } catch (e) {
        console.log('cookie set fail', c.name, e.message);
      }
    }
    console.log('COOKIES_SET', cookies.length, acc.nickname);

    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      webPreferences: {
        partition: 'dm-debug',
        contextIsolation: false,
        nodeIntegration: false,
      },
    });

    win.webContents.setUserAgent(UA);
    win.loadURL('https://www.douyin.com/', { userAgent: UA });

    win.webContents.on('did-finish-load', () => {
      const u = win.webContents.getURL();
      console.log('FINISHED_LOAD', u);
      if (!u.includes('messages')) {
        setTimeout(() => {
          console.log('NAV_TO_MESSAGES');
          win.loadURL('https://www.douyin.com/messages/', { userAgent: UA });
        }, 1500);
      }
    });

    win.webContents.on('did-fail-load', (e, code, desc, url) => {
      console.log('FAIL_LOAD', code, desc, url);
    });

    win.webContents.on('console-message', (event, level, message) => {
      console.log('PAGE_CONSOLE', level, String(message).slice(0, 200));
    });
  } catch (e) {
    console.error('ERR', e);
    app.exit(1);
  }
});
