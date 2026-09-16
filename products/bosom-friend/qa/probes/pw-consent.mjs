import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
// 完整同意流程：勾选 → 点击同意
await page.evaluate(() => { const cb = [...document.querySelectorAll('[role=dialog] button, [role=dialog] span')].find(x => /我已阅读并同意/.test((x.innerText || ''))); const c2 = cb && document.querySelector('[role=dialog]') ? cb.closest('[role=dialog]') : null; if (cb) cb.click(); });
await page.waitForTimeout(400);
const enabled = await page.evaluate(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /同意并进入平台/.test(x.innerText || '')); return b && !b.disabled; });
await page.evaluate(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /同意并进入平台/.test(x.innerText || '')); if (b) b.click(); });
await page.waitForTimeout(1500);
const after = await page.evaluate(() => !!document.querySelector('[role=dialog]'));
const ls = await page.evaluate(() => Object.keys(localStorage).filter(k => k.includes('disclaimer')));
await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(6000);
const afterReload = await page.evaluate(() => !!document.querySelector('[role=dialog]'));
console.log('checkboxEnabledButton=' + enabled + ' dialogClosed=' + (!after) + ' key=' + JSON.stringify(ls) + ' dialogAfterReload=' + afterReload + ' (false=不再打扰)');
await browser.close();