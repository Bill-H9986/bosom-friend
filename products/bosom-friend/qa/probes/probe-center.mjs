import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
const info = await page.evaluate(() => {
  const aside = document.querySelector('aside');
  const link = document.querySelector('[data-testid=sidebar-logo-link]');
  const btn = document.querySelector('[data-testid=sidebar-toggle-btn]');
  const ir = link.querySelector('img').getBoundingClientRect();
  const wr = link.querySelector('h1').getBoundingClientRect();
  const ar = aside.getBoundingClientRect();
  const lr = link.getBoundingClientRect();
  const br = btn ? btn.getBoundingClientRect() : null;
  const asideMid = ar.x + ar.width / 2;
  const logoMid = lr.x + lr.width / 2;
  return JSON.stringify({
    aside: [Math.round(ar.width), Math.round(asideMid)],
    logoBlock: [Math.round(lr.width), Math.round(logoMid)],
    offsetPx: Math.round(logoMid - asideMid),
    img: [Math.round(ir.width)], word: [Math.round(wr.width)],
    collapseBtn: br ? [Math.round(br.x), Math.round(br.y)] : 'hidden',
    centered: Math.abs(logoMid - asideMid) <= 8
  });
});
console.log(info);
await browser.close();