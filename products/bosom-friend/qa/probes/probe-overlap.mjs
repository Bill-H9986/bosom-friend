import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
const measure = () => page.evaluate(() => {
  const aside = document.querySelector('aside');
  const link = document.querySelector('[data-testid=sidebar-logo-link]');
  const btn = document.querySelector('[data-testid=sidebar-toggle-btn]');
  const ar = aside.getBoundingClientRect();
  const lr = link.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const overlap = !(br.right <= lr.left || br.left >= lr.right || br.bottom <= lr.top || br.top >= lr.bottom);
  const overlapImg = (() => { const img = link.querySelector('img'); if (!img) return false; const ir = img.getBoundingClientRect(); return !(br.right <= ir.left || br.left >= ir.right || br.bottom <= ir.top || br.top >= ir.bottom); })();
  return JSON.stringify({ asideW: Math.round(ar.width), link: [Math.round(lr.x), Math.round(lr.y), Math.round(lr.width), Math.round(lr.height)], btn: [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)], overlapBtnLink: overlap, overlapBtnImg: overlapImg, collapsedH1: !!link.querySelector('h1') });
});
console.log('EXPANDED:', await measure());
// click toggle to collapse
await page.evaluate(() => document.querySelector('[data-testid=sidebar-toggle-btn]')?.click());
await page.waitForTimeout(900);
console.log('COLLAPSED:', await measure());
await browser.close();