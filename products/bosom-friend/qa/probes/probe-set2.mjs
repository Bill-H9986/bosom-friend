import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
// hover 头像触发菜单
await page.evaluate(() => { const t = document.querySelector('[data-testid=sidebar-user-trigger]'); t && t.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); });
// 或直接点击头像
await page.evaluate(() => { const t = document.querySelector('[data-testid=sidebar-user-trigger]'); t && t.click(); });
await page.waitForTimeout(600);
const menu = await page.evaluate(() => {
  const t = (document.body.textContent||'');
  return JSON.stringify({ hasContact: t.includes('联系我们'), hasSettings: t.includes('设置') ? 'yes' : 'no', hasNotify: t.includes('消息通知') ? 'yes' : 'no' });
});
console.log('MENU:', menu);
// 点设置
await page.evaluate(() => { const el = document.querySelector('[data-testid=sidebar-settings-entry]'); el && el.click(); });
await page.waitForTimeout(800);
const s = await page.evaluate(() => {
  const dialogs = [].slice.call(document.querySelectorAll('[role=dialog]')).map(d => ({ w: Math.round(d.getBoundingClientRect().width), txt: (d.textContent||'').trim().slice(0, 100) }));
  return JSON.stringify(dialogs);
});
console.log('DIALOGS:', s);
await browser.close();