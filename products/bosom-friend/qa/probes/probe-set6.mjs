import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
// 预置 localStorage 免免责声明
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
const t0 = Date.now();
const snap = async (label) => {
  const s = await page.evaluate(() => {
    const d = [].slice.call(document.querySelectorAll('[role=dialog]')).find(x => x.getBoundingClientRect().width > 400 && /设置/.test((x.textContent||'').slice(0, 100)));
    if (!d) { const any = [].slice.call(document.querySelectorAll('[role=dialog]')).map(x => x.getBoundingClientRect().width); return 'NO SET-DLG, dialogs=' + JSON.stringify(any); }
    const content = d.querySelector('.flex-1.overflow-auto');
    if (!content) return 'NO CONTENT DIV';
    const rect = content.getBoundingClientRect();
    return JSON.stringify({ h: Math.round(rect.height), len: (content.textContent||'').trim().length, head: (content.textContent||'').trim().slice(0, 60) });
  });
  console.log(label + ' +' + (Date.now() - t0) + 'ms: ' + s);
};
await page.evaluate(() => { const t = document.querySelector('[data-testid=sidebar-user-trigger]'); t && t.click(); });
await page.waitForTimeout(500);
await snap('menu');
await page.evaluate(() => { const el = document.querySelector('[data-testid=sidebar-settings-entry]'); el && el.click(); });
await snap('click');
await page.waitForTimeout(150);
await snap('+150');
await page.waitForTimeout(500);
await snap('+650');
await page.waitForTimeout(1000);
await snap('+1650');
await browser.close();