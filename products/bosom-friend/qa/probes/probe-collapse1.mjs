import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(9000);
// 先收起左侧
await page.evaluate(() => document.querySelector('[data-testid=sidebar-toggle-btn]')?.click());
await page.waitForTimeout(800);
const left = await page.evaluate(() => {
  const link = document.querySelector('[data-testid=sidebar-logo-link]');
  const btn = document.querySelector('[data-testid=sidebar-toggle-btn]');
  const img = link ? link.querySelector('img') : null;
  const lr = link ? link.getBoundingClientRect() : null;
  const ir = img ? img.getBoundingClientRect() : null;
  const br = btn ? btn.getBoundingClientRect() : null;
  return JSON.stringify({ img: ir ? [Math.round(ir.x), Math.round(ir.y), Math.round(ir.width), Math.round(ir.height)] : null, btn: br ? [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)] : null, btnOpacity: btn ? getComputedStyle(btn).opacity : '?', imgOpacity: img ? getComputedStyle(img).opacity : '?' });
});
console.log('LEFT COLLAPSED:', left);
await browser.close();