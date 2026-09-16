import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
// 打开时长下拉（点击当前时长 pill）
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /秒|分钟/.test((b.textContent||'').trim())); el && el.click(); });
await page.waitForTimeout(900);
const durOpts = await page.evaluate(() => {
  const btns = [].slice.call(document.querySelectorAll('button')).map(b => ({ t: (b.textContent||'').trim(), dis: b.disabled })).filter(x => /秒|分钟/.test(x.t));
  // 只取下拉弹层内的
  const pop = document.querySelector('[role=dialog], [data-radix-popper-content-wrapper], [class*=popover-content]');
  return { all: btns.slice(0, 20), popText: pop ? (pop.textContent||'').slice(0, 100) : 'no-pop' };
});
console.log('DUR:', JSON.stringify(durOpts));
// Esc 关闭
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
// 打开分辨率下拉
await page.evaluate(() => { const el = [].slice.call(document.querySelectorAll('button')).find(b => /p$/.test((b.textContent||'').trim()) && (b.textContent||'').trim().length < 6); el && el.click(); });
await page.waitForTimeout(900);
const resOpts = await page.evaluate(() => [].slice.call(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /^(480|720|1080)p$|2K$/.test(t)).slice(0, 12);
console.log('RES:', JSON.stringify(resOpts));
await browser.close();