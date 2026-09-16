import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
// 1. 所有 pill 按钮文本
const pills = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /p$/.test(t) || /\d+:\d+$/.test(t) || /秒|分钟|\d+x/.test(t)).slice(0, 24);
});
console.log('PILLS:', JSON.stringify(pills));
// 2. 打开时长下拉
const dur = await page.evaluate(() => document.querySelector('[data-testid=draftbox-ai-duration]'));
if (dur) { await dur.click(); await page.waitForTimeout(900); }
const durOpts = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => ({ t: (b.textContent||'').trim(), dis: b.disabled })).filter(x => /秒|分钟/.test(x.t)).slice(0, 20);
});
console.log('DUR:', JSON.stringify(durOpts));
await browser.close();