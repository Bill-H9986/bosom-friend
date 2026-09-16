import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
const info = await page.evaluate(() => {
  const out = [];
  const nav = document.querySelector('.ring-1.ring-inset, [class*=ring-inset]');
  if (nav) { const cs = getComputedStyle(nav); out.push('active nav color=' + cs.color); }
  const submit = document.querySelector('[data-testid=draftbox-ai-submit-btn]');
  out.push('submit aria=' + (submit ? submit.getAttribute('aria-label') : 'n/a (page)') );
  const sel = document.querySelector('button[role=combobox]');
  out.push('combobox aria=' + (sel ? sel.getAttribute('aria-label') : 'n/a'));
  return out.join('\n');
});
console.log(info);
await browser.close();