import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/settings', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(6000);
// 强制点击系统与更新 tab 并检查版本条
const ver = await page.evaluate(async () => {
  const tab = [].slice.call(document.querySelectorAll('.page-tab')).find(b => /系统与更新/.test((b.textContent||'').trim()));
  if (tab) tab.click();
  await new Promise(r => setTimeout(r, 1000));
  const t = [].slice.call(document.querySelectorAll('div,span,code')).map(e => (e.textContent||'').trim()).filter(x => x.includes('当前系统版本'));
  const verTxt = [].slice.call(document.querySelectorAll('code')).map(e => (e.textContent||'').trim()).filter(x => /^v0/.test(x));
  return JSON.stringify({ found: t.length > 0, sample: t[0] || 'none', verTxt: verTxt[0] || 'none' });
});
console.log('OTA VERSION BAR:', ver);
await browser.close();