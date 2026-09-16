import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const results = [];
let errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
const api = { n: 0 };
page.on('request', r => { if (r.url().includes('/bosom-friend/api')) api.n++; });
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
async function check(key, route) {
  const before = await page.evaluate(k => {
    const b = [...document.querySelectorAll('button:not([disabled])')].find(x => (x.getAttribute('data-testid') || (x.innerText || '').trim().slice(0, 24) + '|' + (x.getAttribute('aria-label') || '')) === k);
    if (!b) return null;
    return { pressed: b.getAttribute('aria-pressed'), sel: b.getAttribute('aria-selected'), cs: b.className.slice(0, 80), txt: document.body.innerText.length, hash: location.hash };
  }, key);
  if (!before) { results.push({ route, btn: key, verdict: 'GONE' }); return; }
  const eb = errs.length, ab = api.n;
  await page.evaluate(k => { const b = [...document.querySelectorAll('button:not([disabled])')].find(x => (x.getAttribute('data-testid') || (x.innerText || '').trim().slice(0, 24) + '|' + (x.getAttribute('aria-label') || '')) === k); if (b) b.click(); }, key);
  await page.waitForTimeout(2500);
  const after = await page.evaluate(k => {
    const b = [...document.querySelectorAll('button:not([disabled])')].find(x => (x.getAttribute('data-testid') || (x.innerText || '').trim().slice(0, 24) + '|' + (x.getAttribute('aria-label') || '')) === k);
    return { pressed: b ? b.getAttribute('aria-pressed') : 'na', sel: b ? b.getAttribute('aria-selected') : 'na', cs: b ? b.className.slice(0, 80) : 'na', txt: document.body.innerText.length, hash: location.hash, dialogs: document.querySelectorAll('[role=dialog]').length };
  }, key);
  const changed = before.pressed !== after.pressed || before.sel !== after.sel || before.cs !== after.cs || Math.abs(after.txt - before.txt) > 40 || after.hash !== before.hash || after.dialogs > 0 || api.n > ab || errs.length > eb;
  results.push({ route, btn: key, verdict: changed ? 'EFFECT' : 'STILL-NOOP', detail: JSON.stringify({ bp: before.pressed, ap: after.pressed, bs: before.sel, as: after.sel, txt: before.txt + '->' + after.txt, dlg: after.dialogs }) });
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
}
const cases = [
  ['热点内容|', '#/ai-interaction'], ['挂载外部库|', '#/knowledge'], ['新建笔记|', '#/knowledge'],
  ['calendar-toggle-solar-festival', '#/calendar'], ['calendar-toggle-solar-term', '#/calendar'], ['calendar-view-week', '#/calendar'],
  ['播放/浏览|', '#/data-statistics'], ['点赞|', '#/data-statistics'], ['评论|', '#/data-statistics'], ['分享|', '#/data-statistics'], ['收藏|', '#/data-statistics'],
  ['刷新|', '#/monitor'], ['通用设置|', '#/settings'],
];
for (const [key, route] of cases) {
  await page.evaluate(rr => { location.hash = rr; }, route);
  await page.waitForTimeout(4000);
  await check(key, route);
}
console.log('VERDICTS:');
for (const r of results) console.log(r.verdict + ' :: ' + r.route + ' :: ' + r.btn.slice(0, 40) + ' ' + (r.detail ? r.detail.slice(0, 120) : ''));
console.log('errs: ' + errs.length);
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/noop-check.json', JSON.stringify(results, null, 1));
await browser.close();