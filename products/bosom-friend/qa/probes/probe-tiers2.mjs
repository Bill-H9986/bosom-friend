import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
// 禁用缓存
await page.route('**/*', route => route.continue());
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000, headers: { 'Cache-Control': 'no-cache' } });
await page.waitForTimeout(8000);
const pills = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /p$/.test(t) || /\d+:\d+$/.test(t) || /秒|分钟/.test(t)).slice(0, 24);
});
console.log('PILLS2:', JSON.stringify(pills));
// 打开分辨率下拉（前一个 720p 按钮）
const resBtn = await page.evaluate(() => [].slice.call(document.querySelectorAll('button')).find(b => /720p/.test((b.textContent||'').trim())));
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /720p/.test((b.textContent||'').trim())); el && el.click(); });
await page.waitForTimeout(800);
const resOpts = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /p$/.test(t)).slice(0, 12);
});
console.log('RES:', JSON.stringify(resOpts));
await browser.close();