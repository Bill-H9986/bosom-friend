import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
await page.evaluate(() => document.querySelector('[data-testid=sidebar-toggle-btn]')?.click());
await page.waitForTimeout(900);
const info = await page.evaluate(() => {
  const link = document.querySelector('[data-testid=sidebar-logo-link]');
  const btn = document.querySelector('[data-testid=sidebar-toggle-btn]');
  const lcs = getComputedStyle(link);
  const bcs = getComputedStyle(btn);
  return JSON.stringify({ linkOpacity: lcs.opacity, btnOpacity: bcs.opacity, linkVisible: parseFloat(lcs.opacity) > 0.5, btnVisible: parseFloat(bcs.opacity) > 0.5, simultaneous: parseFloat(lcs.opacity) > 0.5 && parseFloat(bcs.opacity) > 0.5 });
});
console.log('COLLAPSED idle:', info);
// hover aside
await page.hover('aside');
await page.waitForTimeout(700);
const info2 = await page.evaluate(() => {
  const link = document.querySelector('[data-testid=sidebar-logo-link]');
  const btn = document.querySelector('[data-testid=sidebar-toggle-btn]');
  const lo = parseFloat(getComputedStyle(link).opacity);
  const bo = parseFloat(getComputedStyle(btn).opacity);
  return JSON.stringify({ linkOpacity: lo, btnOpacity: bo, simultaneous: lo > 0.5 && bo > 0.5 });
});
console.log('COLLAPSED hover:', info2);
await browser.close();