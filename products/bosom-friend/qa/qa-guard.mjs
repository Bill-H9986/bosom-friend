// QA-GUARD：历史bug防火墙 + 检测器自检。任何一个断言 FAIL 即 exit 1（不许交付）。
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium } from './browser.mjs';
const require = createRequire(import.meta.url);
const BASE = dirname(fileURLToPath(import.meta.url));
const APP_BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:3080/bosom-friend/';
const chromium = loadChromium();
const results = [];
const ok = (n, c, d) => results.push({ n, pass: !!c, d: d || '' });
// ===== 0) 检测器自检（证明检测模式本身有效，不是纸老虎） =====
ok('SELF-CHECK 关键词检测(应命中)', /知音/.test('a知音b'));
ok('SELF-CHECK 关键词检测(不应误报)', !/知音/.test('Bosom Friend'));
ok('SELF-CHECK 拆行检测(去空白后命中)', /知音/.test('\u77e5\n\u97f3'.replace(/\s+/g, '')));
// ===== 1) 静态防火墙：已知历史遗留词（协议白名单除外） =====
const W = 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/project/bosom-friend-web/src';
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules','dist','dist-electron'].includes(n)) continue; walk(f); } else if (/\.(ts|tsx|json|html)$/.test(n)) files.push(f); } })(W);
const PROTECTED = ['__ZHIYIN_AUTH_TOKEN__', 'zhiyin-agent-session', 'ZhiyinPlugin', 'zhiyin:', 'ZHINYIN_OPEN_CHAT_EVENT'];
const BANNED = ['AISEO', 'AIGEO', 'aitoearn', '知音', 'http://127.0.0.1:8080', 'zhiyin.app', 'Just now', 'm ago', 'h ago', 'd ago'];
let bans = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const cleaned = PROTECTED.reduce((s, p) => s.split(p).join(p.replace(/./g, '\u2588')), src);
  for (const b of BANNED) { if (cleaned.includes(b)) bans.push(f.split('/src/').pop() + ' :: ' + b); }
}
ok('static-禁词零残留(21 文件层)', bans.length === 0, bans.slice(0, 8).join('; '));
// ===== 2) i18n 7 语言键一致性 =====
const langs = ['zh-CN','zh','en','de','fr','ja','ko'];
const routeKeys = JSON.parse(readFileSync(W + '/app/i18n/locales/zh-CN/route.json', 'utf8'));
let keyMiss = [];
for (const l of langs) {
  try { const j = JSON.parse(readFileSync(W + '/app/i18n/locales/' + l + '/route.json', 'utf8')); for (const k of Object.keys(routeKeys)) if (j[k] === undefined) keyMiss.push(l + ':' + k); } catch { keyMiss.push(l + ':file'); }
}
ok('i18n-route 键七语言同步', keyMiss.length === 0, keyMiss.slice(0, 6).join('; '));
// ===== 3) 运行时防火墙：全新用户视角（清上下文） =====
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext()).newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 100)));
const badReplies = [];
page.on('response', async r => { const u = r.url(); if (!u.includes('/bosom-friend/api')) return; try { const ct = (r.headers()['content-type'] || ''); if (!ct.includes('event-stream')) { const j = await r.json(); if (j && j.code !== 0) badReplies.push(r.request().method() + ' ' + u.split('/bosom-friend/api')[1] + ' code=' + j.code); } } catch { /* non-json */ } });
await page.goto(APP_BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
// 全新用户首屏内容（用户 60 秒内所见）
const firstView = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ''));
ok('UX-首屏无禁词', !(/知音|AISEO|AIGEO/.test(firstView)));
ok('UX-品牌字标正确', firstView.includes('BosomFriend'));
// 免责全流程（勾选→按钮→关闭→两处留痕→刷新不再弹）
// 断言必须自带前置：同意状态记在服务端 prefs 里，实例可能早就同意过——
// 不先把服务端记录清成未同意，弹层根本不会出现，旧写法就会把"没弹"当成"已写入"判红/判绿。
await fetch(APP_BASE + 'api/v2/prefs/disclaimer', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ accepted: false }),
}).catch(() => {});
await page.evaluate(() => localStorage.removeItem('bosom-friend-disclaimer-accepted-v1'));
await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(4000);
const dlgShown = await page.evaluate(() => !!document.querySelector('[role=dialog]'));
ok('UX-免责首次弹出', dlgShown);
await page.evaluate(() => { const cb = [...document.querySelectorAll('[role=dialog] button, [role=dialog] span')].find(x => /我已阅读并同意/.test((x.innerText || ''))); if (cb) cb.click(); });
await page.waitForTimeout(400);
await page.evaluate(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /同意并进入平台/.test(x.innerText || '')); if (b && !b.disabled) b.click(); });
await page.waitForTimeout(1500);
const dlgGone = await page.evaluate(() => !document.querySelector('[role=dialog]'));
const dkey = await page.evaluate(() => localStorage.getItem('bosom-friend-disclaimer-accepted-v1'));
ok('UX-免责同意关闭', dlgGone);
ok('UX-免责记录写入(本地副本)', dkey === 'true');
// 刷新不再弹 = 两处留痕任一有效即可（服务端 prefs 是权威，localStorage 只是回填副本）
await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(4000);
const dlgAgain = await page.evaluate(() => !!document.querySelector('[role=dialog]'));
ok('UX-免责刷新不再弹', !dlgAgain);
// 10 页布局 + 全按钮链快检
const routes = ['#/', '#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts'];
for (const rr of routes) {
  await page.evaluate(r2 => { location.hash = r2; }, rr); await page.waitForTimeout(3500);
  const v = await page.evaluate(() => { const doc = document.documentElement; const broken = [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).length; return { ox: doc.scrollWidth > doc.clientWidth + 2, broken, spinner: [...document.querySelectorAll('[class*=spinner]')].filter(e => e.offsetHeight > 0).length > 2, len: document.body.innerText.length }; });
  ok('LAYOUT-' + rr, !v.ox && v.broken === 0 && !v.spinner && v.len > 120, 'ox=' + v.ox + ' broken=' + v.broken + ' len=' + v.len);
}
// API 全链路（30 请求断言）
await page.evaluate(() => { location.hash = '#/draft-box'; }); await page.waitForTimeout(3000);
const t = await page.evaluate(() => { const ta = document.querySelector('textarea'); if (!ta) return false; const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(ta, '功能验证一句话'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; });
if (t) { await page.keyboard.press('Enter'); await page.waitForTimeout(9000); }
ok('UX-页面零错误', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
ok('API-响应全部code=0', badReplies.length === 0, badReplies.slice(0, 5).join('; '));
await browser.close();
// ==== 输出 ====
const fails = results.filter(r => !r.pass);
for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.n + (r.d ? ' :: ' + r.d : ''));
console.log('==== GUARD: ' + (results.length - fails.length) + '/' + results.length + ' pass' + (fails.length ? ' — BLOCKED(不交付)' : ' — 可通过') + ' ====');
// 结果落盘：qa-docsync 自动读此文件同步文档（Guard 固定步骤）
import { writeFileSync as _wfs } from 'node:fs'
try {
  _wfs(BASE + '/last-guard1.json', JSON.stringify({
    name: 'qa-guard',
    runAt: new Date().toISOString(),
    pass: results.length - fails.length,
    total: results.length,
    items: results.map(r => ({ n: r.n, pass: r.pass, d: r.d || '' })),
  }, null, 2))
} catch { /* 落盘失败不阻断门禁 */ }
if (fails.length > 0) process.exit(1);
