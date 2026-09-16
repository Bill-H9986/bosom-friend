import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
const info = await page.evaluate(() => {
  const out = [];
  // 模型选择区文本
  const tabs = [].slice.call(document.querySelectorAll('[role=tab], .page-tab'));
  out.push('TABS: ' + tabs.map(t => (t.textContent||'').trim().slice(0,12)).join(' | '));
  // 是否有模型下拉
  for (const el of [].slice.call(document.querySelectorAll('button'))) {
    const t = (el.textContent||'').trim();
    if (/模型|Model|GPT|doubao|豆包|seedream|即梦|kling|可灵/i.test(t) && t.length < 60) out.push('MODEL-BTN: ' + t.slice(0, 60));
  }
  // 检查 image stack
  const stack = document.querySelector('[data-testid=draftbox-ai-image-stack]');
  out.push('IMAGE-STACK: ' + (stack ? (getComputedStyle(stack).display + ' w=' + Math.round(stack.getBoundingClientRect().width)) : 'MISSING'));
  const add = document.querySelector('[data-testid=draftbox-ai-add-media-btn]');
  out.push('ADD-MEDIA-BTN: ' + (add ? 'present' : 'MISSING'));
  return out.join('\n');
});
console.log(info);
await browser.close();