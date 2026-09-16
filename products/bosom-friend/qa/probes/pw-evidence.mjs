// 前端动作 → 后端请求全链路取证：任何 404/非0 code/空 data 都记录。
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const calls = [];
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
page.on('response', async r => {
  const u = r.url();
  if (!u.includes('/bosom-friend/api')) return;
  const path = u.split('/bosom-friend/api')[1].split('?')[0];
  let note = '';
  try {
    const ct = r.headers()['content-type'] || '';
    if (ct.includes('event-stream')) { note = 'SSE'; }
    else { const j = await r.json(); if (j && j.code !== 0) note = 'code=' + j.code; else if (j && j.data == null) note = 'data=null'; }
  } catch { note = 'non-json'; }
  calls.push({ m: r.request().method(), path, status: r.status(), note });
});
const routes = ['#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts'];
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
// 关闭引导弹窗
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /同意并进入平台/.test(x.innerText || '')); if (b) b.click(); });
await page.waitForTimeout(1200);
for (const rr of routes) {
  await page.evaluate(r2 => { location.hash = r2; }, rr);
  await page.waitForTimeout(3800);
  // 页面常见动作：若存在生成栏，点一次一键发布再关；任务/数据页点主按钮；AI面板发消息
  if (rr === '#/draft-box') {
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '一键发布'); if (b) b.click(); }); await page.waitForTimeout(1200);
    await page.keyboard.press('Escape'); await page.waitForTimeout(600);
  }
  if (rr === '#/data-statistics') {
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '查询数据'); if (b) b.click(); }); await page.waitForTimeout(1800);
  }
}
// AI 面板发一条消息（真实 SSE）
await page.evaluate(() => { location.hash = '#/draft-box'; });
await page.waitForTimeout(3000);
const typed = await page.evaluate(() => { const ta = document.querySelector('textarea'); if (!ta) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '功能验证：请用一句话介绍你自己'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; });
if (typed) {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(9000);
}
const summary = calls.reduce((acc, c) => { const k = c.status + (c.note ? ':' + c.note : ''); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
console.log('total api calls: ' + calls.length);
console.log('summary: ' + JSON.stringify(summary));
const bad = calls.filter(c => c.status >= 400 || (c.note && c.note !== 'SSE'));
console.log('PROBLEM calls: ' + bad.length);
for (const b of bad.slice(0, 30)) console.log('  ' + b.m + ' ' + b.path + ' -> ' + b.status + ' ' + b.note);
console.log('pageerrors: ' + errs.length);
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/api-evidence.json', JSON.stringify({ calls, errs }, null, 1));
console.log('routes hit: ' + [...new Set(calls.map(c => c.path))].length);
await browser.close();