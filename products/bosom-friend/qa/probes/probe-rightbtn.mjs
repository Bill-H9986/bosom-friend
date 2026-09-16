import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(9000);
// 找所有 button 及其位置，重点右侧 AI 面板附近
const btnInfo = await page.evaluate(() => {
  const out = [];
  for (const b of [].slice.call(document.querySelectorAll('button'))) {
    const r = b.getBoundingClientRect();
    if (r.width < 60 && r.height < 60 && r.width > 10 && r.x > 1000) {
      out.push({ t: (b.textContent||'').trim().slice(0,20), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cls: (b.className||'').toString().slice(0, 90) });
    }
  }
  return out;
});
console.log(JSON.stringify(btnInfo, null, 1));
await browser.close();