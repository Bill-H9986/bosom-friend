import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
const info = await page.evaluate(() => {
  const out = [];
  const nav = document.querySelector('nav [class*=ring-inset]');
  if (nav) { const cs = getComputedStyle(nav); out.push('active-nav color=' + cs.color); }
  const submit = document.querySelector('[data-testid=draftbox-ai-submit-btn]');
  out.push('submit aria=' + (submit ? submit.getAttribute('aria-label') : 'none'));
  return out.join('\n');
});
console.log(info);
await page.evaluate(() => { location.hash = '#/calendar'; }); await page.waitForTimeout(4000);
const c2 = await page.evaluate(() => {
  const prev = document.querySelector('[data-testid=calendar-prev-btn]');
  const arr = document.querySelectorAll('button[aria-label]');
  return 'cal prev aria=' + (prev ? prev.getAttribute('aria-label') : 'none') + ' | aria-labeled buttons=' + arr.length;
});
console.log(c2);
await browser.close();