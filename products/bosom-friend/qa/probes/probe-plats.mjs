import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
// 打开平台选择器
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /个平台/.test((b.textContent||'').trim())); el && el.click(); });
await page.waitForTimeout(800);
const plats = await page.evaluate(() => {
  const lbls = [].slice.call(document.querySelectorAll('span,label')).map(e => (e.textContent||'').trim()).filter(t => ['抖音','小红书','快手','视频号','哔哩哔哩','TikTok','YouTube','Instagram'].includes(t));
  return JSON.stringify(lbls);
});
console.log('PLATFORMS IN PICKER:', plats);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// 打开分辨率看档
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /p$/.test((b.textContent||'').trim()) && (b.textContent||'').trim().length <= 4); el && el.click(); });
await page.waitForTimeout(800);
const res = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /480p|720p|1080p|2K$/.test(t)).slice(0, 8);
});
console.log('RES OPTIONS:', JSON.stringify(res));
await browser.close();