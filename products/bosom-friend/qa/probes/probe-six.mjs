import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
const btns = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => t && t.length < 24).slice(0, 40);
});
console.log('BUTTONS:', JSON.stringify(btns));
// 检查探索提示词是否已删
const hasExplore = btns.some(t => t.includes('探索'));
console.log('EXPLORE REMOVED:', !hasExplore);
// 打开分辨率
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /p$/.test((b.textContent||'').trim()) && (b.textContent||'').trim().length <= 4); el && el.click(); });
await page.waitForTimeout(700);
const res = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /480p|720p|1080p|2K$/.test(t)).slice(0, 8);
});
console.log('RES:', JSON.stringify(res));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// 检查风格按钮
const styleBtn = await page.evaluate(() => {
  const el = [].slice.call(document.querySelectorAll('button')).find(b => /风格/.test((b.textContent||'').trim()));
  return el ? el.textContent.trim() : 'MISSING';
});
console.log('STYLE BUTTON:', styleBtn);
await browser.close();