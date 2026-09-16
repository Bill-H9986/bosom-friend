import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /秒|分钟/.test((b.textContent||'').trim())); el && el.click(); });
await page.waitForTimeout(900);
const durOpts = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(x => /秒|分钟/.test(x)).slice(0, 24);
});
console.log('DUR:', JSON.stringify(durOpts));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /p$/.test((b.textContent||'').trim()) && (b.textContent||'').trim().length < 6); el && el.click(); });
await page.waitForTimeout(900);
const resOpts = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /^(480|720|1080)p$|^2K$/.test(t)).slice(0, 12);
});
console.log('RES:', JSON.stringify(resOpts));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
// 比例下拉
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /^\d+:\d+$/.test((b.textContent||'').trim())); el && el.click(); });
await page.waitForTimeout(900);
const ratioOpts = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /^\d+:\d+$/.test(t)).slice(0, 12);
});
console.log('RATIO:', JSON.stringify(ratioOpts));
await browser.close();