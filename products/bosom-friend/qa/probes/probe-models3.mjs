import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const apiCalls = [];
page.on('request', r => { if (r.url().includes('/bosom-friend/api')) apiCalls.push(r.method() + ' ' + r.url().slice(-70)); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
console.log('API CALLS:');
for (const c of apiCalls.slice(0, 30)) console.log('  ', c);
const btns = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button, [role=button]')).map(b => (b.textContent||'').trim().slice(0,40)).filter(t => t.length > 1).slice(0, 45);
});
console.log('BTNS:');
console.log(JSON.stringify(btns));
await browser.close();