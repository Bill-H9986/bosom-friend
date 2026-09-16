import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(10000);
const stat = await page.evaluate(() => {
  return JSON.stringify({ body: (document.body.textContent||'').trim().slice(0, 300), buttons: document.querySelectorAll('button').length, loading: !!document.querySelector('.ant-spin, [class*=loading]') });
});
console.log('STAT:', stat);
await browser.close();