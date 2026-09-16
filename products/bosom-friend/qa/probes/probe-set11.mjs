import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/settings', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(9000);
const s = await page.evaluate(() => {
  const main = document.querySelector('main') || document.body;
  const txt = (main.textContent||'').trim();
  const tabs = [].slice.call(document.querySelectorAll('.page-tab')).map(t => (t.textContent||'').trim());
  return JSON.stringify({ txtLen: txt.length, head: txt.slice(0, 150), tabs });
});
console.log('SETTINGS-PAGE:', s);
await browser.close();