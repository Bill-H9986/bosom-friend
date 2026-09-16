import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
// 点击 trigger 打开（onClick 也 setOpen(true)）
await page.evaluate(() => document.querySelector('[data-testid=sidebar-user-trigger]')?.click());
await page.waitForTimeout(400);
const vis = await page.evaluate(() => {
  const el = document.querySelector('[data-testid=sidebar-settings-entry] button');
  if (!el) return 'NOT FOUND';
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return JSON.stringify({ w: Math.round(r.width), vis: r.width > 0 && cs.display !== 'none' });
});
console.log('settings item:', vis);
await page.evaluate(() => document.querySelector('[data-testid=sidebar-settings-entry] button')?.click());
await page.waitForTimeout(900);
const dialogs = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('[role=dialog]')).map(d => ({ w: Math.round(d.getBoundingClientRect().width), head: (d.textContent||'').trim().slice(0, 40) }));
});
console.log('DIALOGS:', JSON.stringify(dialogs));
await browser.close();