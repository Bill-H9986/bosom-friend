import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
const pills = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /720p|1080p|9:16|16:9|秒|分钟|15|30|60|1:1|4:3|3:4/.test(t)).slice(0, 30);
});
console.log('PILLS:', JSON.stringify(pills));
const dur = await page.evaluate(() => document.querySelector('[data-testid=draftbox-ai-duration]'));
if (dur) { await dur.click(); await page.waitForTimeout(800); }
const durOpts = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => ({ t: (b.textContent||'').trim(), disabled: b.disabled })).filter(x => /秒|分钟/.test(x.t)).slice(0, 20);
});
console.log('DURATION OPTS:', JSON.stringify(durOpts));
await browser.close();