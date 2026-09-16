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
const plus = (route, key, verdict) => results.push({ route, btn: key.slice(0, 60), verdict });
async function snapAndClick(route, queue) {
  let idx = 0, guard = 0;
  while (idx < queue.length && guard < 60) {
    guard++; const key = queue[idx++];
    const eb = errs.length, ab = api.n;
    const domB = await page.evaluate(() => document.body.innerText.length);
    const ok = await page.evaluate(k => { const b = [...document.querySelectorAll('button:not([disabled])')].find(x => (x.getAttribute('data-testid') || (x.innerText || '').trim().slice(0, 24) + '|' + (x.getAttribute('aria-label') || '')) === k); if (!b) return 'gone'; try { b.click(); return 'ok'; } catch (e) { return 'err'; } }, key);
    if (ok !== 'ok') continue;
    await page.waitForTimeout(1000);
    const domA = await page.evaluate(() => document.body.innerText.length);
    const dlg = await page.evaluate(() => document.querySelectorAll('[role=dialog]').length);
    let v = 'NOOP';
    if (errs.length > eb) v = 'ERROR';
    else if (api.n > ab || Math.abs(domA - domB) > 30 || dlg > 0) v = 'EFFECT';
    plus(route, key, v);
    if (v === 'ERROR') console.log('!! ' + route + ' :: ' + key + ' :: ' + errs[errs.length - 1]);
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  }
}
const collect = async () => page.evaluate(() => {
  const seen = new Set(); const out = [];
  for (const b of document.querySelectorAll('button:not([disabled])')) {
    const r = b.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue;
    const k = b.getAttribute('data-testid') || ((b.innerText || '').trim().slice(0, 24) + '|' + (b.getAttribute('aria-label') || ''));
    if (seen.has(k)) continue; seen.add(k); out.push(k);
  } return out;
});
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
// 0) 关闭免责引导弹窗
const agree = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /同意并进入平台/.test(x.innerText || '')); if (b) { b.click(); return true; } return false; });
await page.waitForTimeout(1200);
plus('#/welcome', '同意并进入平台', agree ? 'EFFECT' : 'GONE');
// 1) 添加频道弹窗内
await page.evaluate(() => document.querySelector('[data-testid=sidebar-account-entry]').click());
await page.waitForTimeout(1500);
await snapAndClick('#modal-channel', await collect());
// 2) 内容创作弹开销: 一键发布
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
await page.evaluate(() => { location.hash = '#/draft-box'; }); await page.waitForTimeout(4500);
const pub = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '一键发布'); if (b) { b.click(); return true; } return false; });
await page.waitForTimeout(1500);
if (pub) await snapAndClick('#modal-publish', await collect()); else plus('#modal-publish', '(no open)', 'GONE');
// 3) AI 面板提示词/发送
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
const aiClicks = await collect();
await snapAndClick('#ai-panel', aiClicks.filter(k => /新对话|帮我|Upload|发送/.test(k)));
const summary = {};
for (const r of results) summary[r.verdict] = (summary[r.verdict] || 0) + 1;
console.log(JSON.stringify(summary));
console.log('total re-checked: ' + results.length);
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/tour2.json', JSON.stringify({ results, errs }, null, 1));
for (const r of results.filter(x => x.verdict !== 'EFFECT')) console.log(r.verdict + ' :: ' + r.route + ' :: ' + r.btn);
console.log('errs: ' + errs.length);
await browser.close();