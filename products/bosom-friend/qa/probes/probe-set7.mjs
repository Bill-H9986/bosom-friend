import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
// 用真实 mouse hover + click 而非 dispatch
const trigger = page.locator('[data-testid=sidebar-user-trigger]');
await trigger.hover();
await page.waitForTimeout(400);
const settingsItem = page.locator('[data-testid=sidebar-settings-entry] button');
const vis = await settingsItem.isVisible().catch(() => false);
console.log('settings item visible:', vis);
if (vis) { await settingsItem.click(); }
await page.waitForTimeout(800);
const dialogs = await page.evaluate(() => [].slice.call(document.querySelectorAll('[role=dialog]')).map(d => ({ w: Math.round(d.getBoundingClientRect().width), head: (d.textContent||'').trim().slice(0, 40) }));
console.log('DIALOGS:', JSON.stringify(dialogs));
await browser.close();