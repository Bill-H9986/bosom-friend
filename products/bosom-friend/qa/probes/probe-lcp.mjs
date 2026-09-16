import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => {
  window.__lcpInfo = null;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__lcpInfo = { startTime: Math.round(e.startTime), size: e.size, url: (e.url||'').slice(0,120), tag: e.element ? e.element.tagName + '.' + (e.element.className||'').toString().slice(0,80) : '?' };
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });
});
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(() => window.__lcpInfo), null, 1));
// top slowest resources
const slow = await page.evaluate(() => {
  const res = performance.getEntriesByType('resource').map(r => ({ u: r.name.slice(0, 100), ms: Math.round(r.duration), kb: Math.round((r.transferSize||0)/1024) }));
  return res.sort((a,b)=>b.ms-a.ms).slice(0, 12);
});
console.log(JSON.stringify(slow, null, 1));
await browser.close();