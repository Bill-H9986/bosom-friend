import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
const info = await page.evaluate(() => {
  const add = document.querySelector('[data-testid=draftbox-ai-add-media-btn]');
  const stack = document.querySelector('[data-testid=draftbox-ai-image-stack]');
  const fileInputs = [].slice.call(document.querySelectorAll('input[type=file]'));
  return JSON.stringify({ addMediaBtn: add ? 'present' : 'MISSING', stack: stack ? 'present' : 'MISSING', fileInputs: fileInputs.length, addRect: add ? JSON.stringify(add.getBoundingClientRect()) : 'n/a' });
});
console.log(info);
// 点击添加按钮 → 文件选择器应触发
const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
await page.evaluate(() => document.querySelector('[data-testid=draftbox-ai-add-media-btn]')?.click());
const chooser = await chooserPromise;
console.log('file chooser triggered:', chooser ? 'YES' : 'NO');
await browser.close();