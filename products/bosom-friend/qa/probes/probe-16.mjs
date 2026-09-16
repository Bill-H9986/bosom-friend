import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(10000);
// 点风格按钮（当前显示口播实拍）
const styleClick = await page.evaluate(() => {
  const el = [].slice.call(document.querySelectorAll('button')).find(b => /口播实拍|电影感/.test((b.textContent||'').trim()));
  if (el) el.click();
  return !!el;
});
console.log('style clicked:', styleClick);
await page.waitForTimeout(700);
const styleOpts = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => ['口播实拍','电影感','快节奏混剪','叙事旅行','产品大片','生活纪录'].includes(t)).slice(0, 8);
});
console.log('STYLE OPTS:', JSON.stringify(styleOpts));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// 切到图片模式
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('[role=tab],button')).find(b => /图片/.test((b.textContent||'').trim())); el && el.click(); });
await page.waitForTimeout(2500);
const imgBtns = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => ['写实','插画','水彩','油画','卡通','赛博朋克','电影感','极简','1024x1024'].includes(t)).slice(0, 10);
});
console.log('IMG MODE STYLE/RES:', JSON.stringify(imgBtns));
await browser.close();