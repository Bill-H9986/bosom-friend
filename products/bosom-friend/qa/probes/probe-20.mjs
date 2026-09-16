import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true'); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(10000);
await page.evaluate(() => { const el = document.querySelector('[data-testid=draftbox-ai-gen-mode]'); el && el.click(); });
await page.waitForTimeout(600);
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /图文/.test((b.textContent||'').trim())); el && el.click(); });
await page.waitForTimeout(2500);
const resBtn = await page.evaluate(() => {
  const el = [].slice.call(document.querySelectorAll('button')).find(b => /x\d+x\d+/.test((b.textContent||'').trim()));
  return el ? el.textContent.trim() : 'MISSING';
});
console.log('IMG RES BTN:', resBtn);
await page.evaluate(() => {
  const el = [].slice.call(document.querySelectorAll('button')).find(b => /x\d+x\d+/.test((b.textContent||'').trim()));
  el && el.click();
});
await page.waitForTimeout(800);
const resOpts = await page.evaluate(() => {
  return [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /^\d+x\d+$/.test(t)).slice(0, 8);
});
console.log('IMG RES OPTS:', JSON.stringify(resOpts));
await browser.close();