import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
await page.evaluate(() => { const cb = [].slice.call(document.querySelectorAll('[role=dialog] button')).find(x => /我已阅读并同意/.test(x.innerText||'')); cb && cb.click(); });
await page.waitForTimeout(300);
await page.evaluate(() => { const b = [].slice.call(document.querySelectorAll('[role=dialog] button')).find(x => /同意并进入平台/.test(x.innerText||'')); b && !b.disabled && b.click(); });
await page.waitForTimeout(1200);
// 直接从 React 侧打开 —— 通过点击通知弹窗齿轮（这是用户确认可用的入口）
// 打开通知弹窗
const t0 = Date.now();
const snapshot = async (label) => {
  const s = await page.evaluate(() => {
    const d = [].slice.call(document.querySelectorAll('[role=dialog]')).find(x => x.getBoundingClientRect().width > 300);
    if (!d) return 'NONE';
    const content = d.querySelector('.flex-1.overflow-auto');
    if (!content) return 'NO CONTENT-DIV: ' + d.className.slice(0, 60);
    const rect = content.getBoundingClientRect();
    return JSON.stringify({ h: Math.round(rect.height), txtLen: (content.textContent||'').trim().length });
  });
  console.log(label + ' [' + (Date.now() - t0) + 'ms]:', s);
};
await page.evaluate(() => { const t = document.querySelector('[data-testid=sidebar-user-trigger]'); t && t.click(); });
await page.waitForTimeout(500);
await snapshot('menu-open');
await page.evaluate(() => { const el = document.querySelector('[data-testid=sidebar-settings-entry]'); el && el.click(); });
await snapshot('settings-clicked');
await page.waitForTimeout(400);
await snapshot('+400ms');
await page.waitForTimeout(1500);
await snapshot('+1900ms');
await browser.close();