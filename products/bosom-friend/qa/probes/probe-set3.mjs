import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
// 依次处理免责声明（如果出现）
await page.evaluate(() => { const b = [].slice.call(document.querySelectorAll('button')).find(x => /我已阅读并同意/.test(x.innerText||'')); b && b.click(); });
await page.waitForTimeout(400);
await page.evaluate(() => { const b = [].slice.call(document.querySelectorAll('button')).find(x => /同意并进入平台/.test(x.innerText||'')); b && !b.disabled && b.click(); });
await page.waitForTimeout(1000);
// hover+点头像打开菜单
await page.evaluate(() => { const t = document.querySelector('[data-testid=sidebar-user-trigger]'); t && t.click(); });
await page.waitForTimeout(600);
await page.evaluate(() => { const el = document.querySelector('[data-testid=sidebar-settings-entry]'); el && el.click(); });
await page.waitForTimeout(300);
const early = await page.evaluate(() => {
  const d = [].slice.call(document.querySelectorAll('[role=dialog]')).find(x => /设置/.test(x.textContent||'') && x.getBoundingClientRect().width > 300);
  if (!d) return 'NO SETTINGS DIALOG';
  const content = d.querySelector('.flex-1.overflow-auto');
  const cs = content ? getComputedStyle(content) : null;
  const h = content ? content.getBoundingClientRect().height : 0;
  const txt = content ? (content.textContent||'').trim().length : -1;
  return JSON.stringify({ h: Math.round(h), txtLen: txt, textHead: (content.textContent||'').trim().slice(0, 80) });
});
console.log('EARLY:', early);
await page.waitForTimeout(2000);
const late = await page.evaluate(() => {
  const d = [].slice.call(document.querySelectorAll('[role=dialog]')).find(x => /设置/.test(x.textContent||'') && x.getBoundingClientRect().width > 300);
  if (!d) return 'NO DIALOG';
  const content = d.querySelector('.flex-1.overflow-auto');
  const txt = content ? (content.textContent||'').trim().length : -1;
  return JSON.stringify({ txtLen: txt });
});
console.log('LATE:', late);
await browser.close();