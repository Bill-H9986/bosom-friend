import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const el = document.querySelector('.file\\:border-0');
  if (!el) return 'none';
  return 'TYPE=' + el.type + ' CLS=' + el.className + '\nPLACEHOLDER=' + (el.getAttribute('placeholder')||'') + '\nVALUE=' + el.value + '\nPARENT=' + (el.parentElement ? el.parentElement.outerHTML.slice(0, 300) : '');
});
console.log(info);
await browser.close();