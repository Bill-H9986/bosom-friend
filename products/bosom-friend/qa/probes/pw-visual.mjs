import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const report = {};
const routes = ['#/', '#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts'];
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
// 完整同意免责流程（勾选→同意→记录）
await page.evaluate(() => { const cb = [...document.querySelectorAll('[role=dialog] button, [role=dialog] span')].find(x => /我已阅读并同意/.test((x.innerText || ''))); if (cb) cb.click(); });
await page.waitForTimeout(400);
await page.evaluate(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /同意并进入平台/.test(x.innerText || '')); if (b && !b.disabled) b.click(); });
await page.waitForTimeout(1500);
for (const r of routes) {
  await page.evaluate(rr => { location.hash = rr; }, r);
  await page.waitForTimeout(3800);
  const v = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth > doc.clientWidth + 2;
    const widest = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.right > innerWidth + 6 && rect.width > 40 && rect.height > 16) widest.push(((el.className || el.tagName) + '').slice(0, 60));
      if (widest.length >= 4) break;
    }
    const broken = [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).length;
    const spinners = [...document.querySelectorAll('[class*=spinner],[class*=Spin]')].filter(el => el.offsetHeight > 0).length;
    const dialogs = document.querySelectorAll('[role=dialog]').length;
    const zeroH = [...document.querySelectorAll('main, [class*=content]')].filter(el => el.offsetHeight === 0 && el.offsetWidth > 100).length;
    const nothing = document.body.innerText.trim().length < 60 && spinners === 0;
    const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => (h.innerText || '').trim().slice(0, 22)).filter(Boolean).slice(0, 5);
    const tinyBtns = [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); return r.height > 0 && r.height < 24; }).length;
    return { overflowX, widest, broken, spinners, dialogs, zeroH, nothing, headings, tinyBtns, len: document.body.innerText.length };
  });
  const problems = [];
  if (v.overflowX) problems.push('横向溢出:' + v.widest.join('|'));
  if (v.broken > 0) problems.push('破图x' + v.broken);
  if (v.spinners > 2) problems.push('spinner残留x' + v.spinners);
  if (v.dialogs > 0 && r !== '#/accounts') problems.push('弹窗残留x' + v.dialogs);
  if (v.zeroH > 0) problems.push('零高容器x' + v.zeroH);
  if (v.nothing) problems.push('页面空白');
  if (v.headings.length === 0) problems.push('无标题');
  report[r] = { ...v, verdict: problems.length === 0 ? 'PASS' : 'FAIL: ' + problems.join('; ') };
}
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/visual.json', JSON.stringify(report, null, 1));
for (const [k, v] of Object.entries(report)) console.log((v.verdict === 'PASS' ? 'PASS ' : 'FAIL ') + k + ' :: ' + (v.verdict === 'PASS' ? ('h:' + JSON.stringify(v.headings) + ' len:' + v.len + ' tiny:' + v.tinyBtns) : v.verdict));
await browser.close();