import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const api = [];
page.on('request', r => { if (r.url().includes('/bosom-friend/api')) api.push(r.method() + ' ' + r.url().slice(20)); });
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
console.log('ALL API:');
for (const c of api) console.log(' ', c);
// fetch model list directly
const models = await page.evaluate(async () => {
  try { const r = await fetch('/bosom-friend/api/v2/ai/models?type=video'); return 'direct video models: ' + (r.ok ? await r.text() : r.status); } catch(e) { return 'fetch fail ' + e; }
});
console.log(models.slice(0, 800));
await browser.close();