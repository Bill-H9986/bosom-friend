// 全量按钮点击遍历：每页收集→点击→验证副作用→进入新弹层→关闭→下一批。结果写 JSON 并打印汇总。
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const base = 'http://127.0.0.1:3081/bosom-friend/';
const routes = ['#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings'];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
const apiCalls = { n: 0 };
page.on('request', r => { const u = r.url(); if (u.includes('/bosom-friend/api') || u.includes('/bosom-friend/assets')) apiCalls.n++; });
const results = [];
let clicked = 0;
async function collectButtons() {
  return await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const b of document.querySelectorAll('button:not([disabled])')) {
      const r = b.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
      const key = b.getAttribute('data-testid') || (b.innerText || '').trim().slice(0, 24) + '|' + (b.getAttribute('aria-label') || '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, visible: true });
    }
    return out;
  });
}
async function closeOverlays() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
}
await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
for (const route of routes) {
  await page.evaluate(rr => { location.hash = rr; }, route);
  await page.waitForTimeout(4500);
  await closeOverlays();
  const queue = await collectButtons();
  let idx = 0;
  let guard = 0;
  while (idx < queue.length && guard < 260) {
    guard++;
    const item = queue[idx++];
    const errBefore = errs.length;
    const apiBefore = apiCalls.n;
    const domBefore = await page.evaluate(() => document.body.innerText.length);
    const clickedOk = await page.evaluate(k => {
      const cands = [...document.querySelectorAll('button:not([disabled])')];
      const b = cands.find(x => (x.getAttribute('data-testid') || (x.innerText || '').trim().slice(0, 24) + '|' + (x.getAttribute('aria-label') || '')) === k);
      if (!b) return 'gone';
      try { b.click(); return 'ok'; } catch (e) { return 'err'; }
    }, item.key);
    if (clickedOk !== 'ok') { if (clickedOk === 'gone') continue; results.push({ route, btn: item.key, verdict: 'CLICK-ERR' }); continue; }
    await page.waitForTimeout(1100);
    const errAfter = errs.length;
    const apiAfter = apiCalls.n;
    const domAfter = await page.evaluate(() => document.body.innerText.length);
    const dialogOpen = await page.evaluate(() => document.querySelectorAll('[role=dialog]').length);
    const ariaOpen = await page.evaluate(() => document.querySelectorAll('[data-state=open]').length);
    let verdict = 'NOOP';
    if (errAfter > errBefore) verdict = 'ERROR(' + (errs[errAfter - 1] || '').slice(0, 60) + ')';
    else if (apiAfter > apiBefore) verdict = 'API';
    else if (Math.abs(domAfter - domBefore) > 40 || dialogOpen > 0 || ariaOpen > 0) verdict = 'DOM';
    clicked++;
    results.push({ route, btn: item.key, verdict });
    if (verdict.startsWith('ERROR')) console.log('!! ERROR on ' + route + ' :: ' + item.key);
    // 弹层打开则把新按钮并入队列
    if ((dialogOpen > 0 || ariaOpen > 0) && guard < 250) {
      const more = await collectButtons();
      for (const m of more) { if (!queue.some(q => q.key === m.key)) queue.push(m); }
    }
    await closeOverlays();
  }
}
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/btn-tour.json', JSON.stringify({ results, errs }, null, 1));
const summary = {};
for (const r of results) summary[r.verdict.startsWith('ERROR') ? 'ERROR' : r.verdict] = (summary[r.verdict.startsWith('ERROR') ? 'ERROR' : r.verdict] || 0) + 1;
console.log('CLICKED=' + clicked + ' RESULTS=' + results.length);
console.log(JSON.stringify(summary));
const noops = results.filter(r => r.verdict === 'NOOP');
console.log('NOOP (no observable effect) count: ' + noops.length);
for (const n of noops.slice(0, 30)) console.log('  NOOP ' + n.route + ' :: ' + n.btn.slice(0, 60));
const errors = results.filter(r => r.verdict.startsWith('ERROR'));
console.log('ERRORS: ' + errors.length);
for (const e of errors.slice(0, 20)) console.log('  ' + e.route + ' :: ' + e.btn.slice(0, 50) + ' :: ' + e.verdict.slice(0, 90));
await browser.close();