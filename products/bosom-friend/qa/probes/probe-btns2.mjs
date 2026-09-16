import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(9000);
const check = async (tid, label) => {
  const s = await page.evaluate((tid2) => {
    const el = document.querySelector(tid2);
    if (!el) return 'NOT FOUND';
    const cs = getComputedStyle(el);
    return JSON.stringify({ cls: (el.className||'').toString().slice(0, 110), radius: cs.borderRadius, border: cs.borderStyle + ' ' + cs.borderColor.slice(0, 20), bg: cs.backgroundColor, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), color: cs.color });
  }, tid);
  console.log(label + ':', s);
};
await check('[data-testid=sidebar-toggle-btn]', 'LEFT');
await check('[data-testid=ai-assistant-collapse-btn]', 'RIGHT');
await browser.close();