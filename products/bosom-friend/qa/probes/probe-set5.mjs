import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
// 点击通知弹窗里的齿轮 → openSettings()
await page.evaluate(() => { const t = document.querySelector('[data-testid=sidebar-user-trigger]'); t && t.click(); });
await page.waitForTimeout(500);
const hasNotifEntry = await page.evaluate(() => !!document.querySelector('[data-testid=sidebar-notification-entry]'));
console.log('notification entry:', hasNotifEntry);
await page.evaluate(() => { const el = document.querySelector('[data-testid=sidebar-notification-entry]'); el && el.click(); });
await page.waitForTimeout(600);
const notifOpen = await page.evaluate(() => {
  const d = [].slice.call(document.querySelectorAll('[role=dialog]')).find(x => /消息通知/.test(x.textContent||''));
  return d ? 'YES' : 'NO';
});
console.log('notification dialog:', notifOpen);
// 点齿轮设置
await page.evaluate(() => {
  const d = [].slice.call(document.querySelectorAll('[role=dialog]')).find(x => /消息通知/.test(x.textContent||''));
  if (d) { const g = [].slice.call(d.querySelectorAll('button')).find(b => b.getAttribute('title') === '设置'); g && g.click(); }
});
await page.waitForTimeout(800);
const settingsAfterGear = await page.evaluate(() => {
  const ds = [].slice.call(document.querySelectorAll('[role=dialog]')).map(d => ({ w: Math.round(d.getBoundingClientRect().width), t: /设置/.test((d.textContent||'').slice(0, 200)) ? 'SET' : (d.textContent||'').slice(0, 30) }));
  return JSON.stringify(ds);
});
console.log('after gear:', settingsAfterGear);
await browser.close();