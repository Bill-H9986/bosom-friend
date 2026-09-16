import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(9000);
await page.evaluate(() => document.querySelector('[data-testid=sidebar-toggle-btn]')?.click());
await page.waitForTimeout(800);
const left = await page.evaluate(() => {
  const img = document.querySelector('[data-testid=sidebar-logo-link] img');
  const btn = document.querySelector('[data-testid=sidebar-toggle-btn]');
  const ir = img ? img.getBoundingClientRect() : null;
  const br = btn ? btn.getBoundingClientRect() : null;
  if (!ir || !br) return 'MISSING';
  const overlap = !(br.right <= ir.left || br.left >= ir.right || br.bottom <= ir.top || br.top >= ir.bottom);
  const vertical = br.top >= ir.bottom - 2;
  return JSON.stringify({ img: [Math.round(ir.y), Math.round(ir.height)], btn: [Math.round(br.y), Math.round(br.height)], overlap, verticalBelow: vertical, bothVisible: getComputedStyle(img).opacity === '1' && getComputedStyle(btn).opacity === '1' });
});
console.log('LEFT COLLAPSED NEW:', left);
// 右侧 AI 收起
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-collapse-btn]')?.click());
await page.waitForTimeout(800);
const right = await page.evaluate(() => {
  const img = document.querySelector('[data-testid=ai-assistant-sidebar] img');
  const btn = document.querySelector('[data-testid=ai-assistant-expand-btn]');
  const ir = img ? img.getBoundingClientRect() : null;
  const br = btn ? btn.getBoundingClientRect() : null;
  if (!ir || !br) return 'MISSING';
  const overlap = !(br.right <= ir.left || br.left >= ir.right || br.bottom <= ir.top || br.top >= ir.bottom);
  return JSON.stringify({ img: [Math.round(ir.y), Math.round(ir.height)], btn: [Math.round(br.y), Math.round(br.height)], overlap, below: br.top >= ir.bottom - 2 });
});
console.log('RIGHT COLLAPSED:', right);
await browser.close();