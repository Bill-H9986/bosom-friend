import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(10000);
// 找内容类型 tabs（全部/草稿/视频/图片）—— 点图片视图标签
const tabs = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('[role=tab]')).map(t => (t.textContent||'').trim());
});
console.log('TABS:', JSON.stringify(tabs));
// 点图片 tab
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('[role=tab]')).find(b => (b.textContent||'').trim() === '图片'); el && el.click(); });
await page.waitForTimeout(3000);
const btns = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => t.length < 26).slice(0, 40);
});
console.log('IMG TAB BUTTONS:', JSON.stringify(btns));
await browser.close();