import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
// 打开头像设置（弹窗）
await page.evaluate(() => { const el = document.querySelector('[data-testid=sidebar-settings-entry]'); el && el.click(); });
await page.waitForTimeout(400);
const s1 = await page.evaluate(() => {
  const d = [].slice.call(document.querySelectorAll('[role=dialog]')).find(x => /设置/.test(x.textContent||''));
  if (!d) return 'NO DIALOG';
  const txt = (d.textContent||'').trim();
  const visible = d.getBoundingClientRect().width > 0;
  return JSON.stringify({ visible, len: txt.length, head: txt.slice(0, 120) });
});
console.log('SETTINGS-OPEN-400ms:', s1);
await page.waitForTimeout(2000);
const s2 = await page.evaluate(() => {
  const d = [].slice.call(document.querySelectorAll('[role=dialog]')).find(x => /设置/.test(x.textContent||''));
  if (!d) return 'NO DIALOG';
  const txt = (d.textContent||'').trim();
  return JSON.stringify({ len: txt.length, head: txt.slice(0, 200) });
});
console.log('SETTINGS-OPEN-2400ms:', s2);
await browser.close();