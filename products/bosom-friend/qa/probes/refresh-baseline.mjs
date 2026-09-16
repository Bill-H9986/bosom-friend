import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
await page.evaluate(() => { const cb = [...document.querySelectorAll('[role=dialog] button, [role=dialog] span')].find(x => /我已阅读并同意/.test((x.innerText || ''))); if (cb) cb.click(); }); await page.waitForTimeout(400);
await page.evaluate(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /同意并进入平台/.test(x.innerText || '')); if (b && !b.disabled) b.click(); }); await page.waitForTimeout(1200);
const routes = ['#/', '#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts'];
const latest = {};
for (const rr of routes) {
  await page.evaluate(r2 => { location.hash = r2; }, rr); await page.waitForTimeout(3000);
  const sig = await page.evaluate(() => {
    const parts = [];
    const els = document.querySelectorAll('aside, main, [data-testid=sidebar-nav], h1, .page-enter');
    for (const el of [].slice.call(els).slice(0, 8)) { const r = el.getBoundingClientRect(); parts.push([el.tagName, (el.className || '').toString().slice(0, 40), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]); }
    return JSON.stringify(parts).slice(0, 400);
  });
  latest[rr] = sig;
}
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/visual-baseline.json', JSON.stringify(latest, null, 2));
console.log('baseline re-frozen, 10 routes');
await browser.close();