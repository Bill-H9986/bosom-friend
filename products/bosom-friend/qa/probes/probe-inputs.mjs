import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('input')) out.push(el.type + ' :: ' + el.className.slice(0, 160));
  // find all buttons with color-contrast risk: check computed color of tab triggers
  const trig = document.querySelector('[role=tab][aria-selected=false]');
  if (trig) { const cs = getComputedStyle(trig); out.push('INACTIVE-TAB: color=' + cs.color + ' bg=' + cs.backgroundColor + ' size=' + cs.fontSize); }
  const plat = document.querySelector('.w-7');
  if (plat) { const cs = getComputedStyle(plat); out.push('W7-BTN: color=' + cs.color); }
  return out.join('\n');
});
console.log(info);
await browser.close();