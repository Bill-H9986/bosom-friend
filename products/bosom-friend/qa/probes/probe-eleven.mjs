import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// 禁用缓存
await ctx.route('**/*', route => route.continue());
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 220)));
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 180000, headers: { 'Cache-Control': 'no-cache' } });
await page.waitForTimeout(10000);
console.log('ERR:', errs[0] || 'NONE');
const stat = await page.evaluate(() => JSON.stringify({ body: (document.body.textContent||'').trim().slice(0, 160), btn: document.querySelectorAll('button').length }));
console.log('STAT:', stat);
await browser.close();