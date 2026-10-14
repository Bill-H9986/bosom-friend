// QA-GUARD：历史bug防火墙 + 检测器自检。任何一个断言 FAIL 即 exit 1（不许交付）。
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium } from './browser.mjs';
const require = createRequire(import.meta.url);
const BASE = dirname(fileURLToPath(import.meta.url));
const APP_BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/';
const chromium = loadChromium();
const results = [];
const ok = (n, c, d) => results.push({ n, pass: !!c, d: d || '' });
/**
 * 把图片 URL 分类为同源/外部。解析失败时按**同源**处理（保守：宁可报红也不漏报产品自身资源问题）。
 * @param src - 图片地址（currentSrc 或 src）。
 * @param pageOrigin - 当前页面 origin。
 * @returns 'local' | 'external'
 */
function classifyImgUrl(src, pageOrigin) {
  if (!src) return 'local'
  try {
    const u = new URL(src, pageOrigin)
    return u.origin === pageOrigin ? 'local' : 'external'
  } catch {
    return 'local'
  }
}

/**
 * LAYOUT 判定：**本地资源失败阻塞，外部依赖失败只告警**。
 * 扫描本身失败时不得伪装成正常。
 * @param v - { ox, spinner, len, brokenLocal, brokenExternal, scanFailed }
 * @returns { pass, reason, warning }
 */
function judgeLayout(v) {
  if (v.scanFailed) return { pass: false, reason: 'IMG_SCAN_FAILED', warning: null }
  if (v.ox) return { pass: false, reason: 'OVERFLOW_X', warning: null }
  if (v.spinner) return { pass: false, reason: 'SPINNER_STUCK', warning: null }
  if (v.len <= 120) return { pass: false, reason: 'TOO_SHORT', warning: null }
  if (v.brokenLocal > 0) return { pass: false, reason: 'BROKEN_LOCAL_IMG', warning: null }
  return { pass: true, reason: null, warning: v.brokenExternal > 0 ? 'EXTERNAL_IMG_UNAVAILABLE' : null }
}

/** 只记来源主机与错误类型，不写完整 URL（避免把查询参数带进日志）。 */
function externalHostOnly(src) {
  try { return new URL(src).host } catch { return '(unparsable)' }
}
// ===== 0) 检测器自检（证明检测模式本身有效，不是纸老虎） =====
ok('SELF-CHECK 关键词检测(应命中)', /知音/.test('a知音b'));
ok('SELF-CHECK 关键词检测(不应误报)', !/知音/.test('Bosom Friend'));
ok('SELF-CHECK 拆行检测(去空白后命中)', /知音/.test('\u77e5\n\u97f3'.replace(/\s+/g, '')));
ok('SELF-CHECK LAYOUT 同源图片失败→红', judgeLayout({ ox: false, spinner: false, len: 500, brokenLocal: 1, brokenExternal: 0 }).pass === false);
ok('SELF-CHECK LAYOUT 外链图片失败→告警但不阻塞', (() => { const r = judgeLayout({ ox: false, spinner: false, len: 500, brokenLocal: 0, brokenExternal: 1 }); return r.pass === true && r.warning === 'EXTERNAL_IMG_UNAVAILABLE' })());
ok('SELF-CHECK LAYOUT 外链正常→无告警', judgeLayout({ ox: false, spinner: false, len: 500, brokenLocal: 0, brokenExternal: 0 }).warning === null);
ok('SELF-CHECK LAYOUT 扫描失败→不得伪装成正常', judgeLayout({ scanFailed: true }).pass === false);
ok('SELF-CHECK 图片分类 同源→local', classifyImgUrl('http://127.0.0.1:31280/bosom-friend/a.svg', 'http://127.0.0.1:31280') === 'local');
ok('SELF-CHECK 图片分类 外链→external', classifyImgUrl('https://p26.douyinpic.com/a.jpeg', 'http://127.0.0.1:31280') === 'external');
ok('SELF-CHECK 图片分类 非法URL→按 local 保守处理', classifyImgUrl('not a url', 'http://127.0.0.1:31280') === 'local');
// ===== 1) 静态防火墙：已知历史遗留词（协议白名单除外） =====
const W = 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/project/bosom-friend-web/src';
// 前端源码可能被整目录重构/移出（2026-10-13 实测：这个 src 被归档到 archive/ 下、目录消失）。
// 目录不在时**必须判红并说明**：否则 files 为空 → 后面每一条「零残留 / 零注入」断言都会假绿。
const WEB_SRC_EXISTS = existsSync(W);
ok('static-前端源码目录存在', WEB_SRC_EXISTS, WEB_SRC_EXISTS ? W : ('不存在：' + W + '——前端可能已整目录重构/移出，请把本脚本的 W 指到新的源码目录（否则下面的静态断言全部失去意义）'));
const files = [];
if (WEB_SRC_EXISTS) (function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); const st = statSync(f); if (st.isDirectory()) { if (['node_modules','dist','dist-electron'].includes(n)) continue; walk(f); } else if (/\.(ts|tsx|json|html)$/.test(n)) files.push(f); } })(W);
const PROTECTED = ['__ZHIYIN_AUTH_TOKEN__', 'zhiyin-agent-session', 'ZhiyinPlugin', 'zhiyin:', 'ZHINYIN_OPEN_CHAT_EVENT'];
const BANNED = ['AISEO', 'AIGEO', 'aitoearn', '知音', 'http://127.0.0.1:8080', 'zhiyin.app', 'Just now', 'm ago', 'h ago', 'd ago'];
let bans = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const cleaned = PROTECTED.reduce((s, p) => s.split(p).join(p.replace(/./g, '\u2588')), src);
  for (const b of BANNED) { if (cleaned.includes(b)) bans.push(f.split('/src/').pop() + ' :: ' + b); }
}
ok('static-禁词零残留(21 文件层)', bans.length === 0, bans.slice(0, 8).join('; '));
// ===== 1.2) 冻结前端模式：静态防火墙必须覆盖**被交付的产物**（2026-10-13 立） =====
//
// 背景（FRONTEND-FROZEN.md）：前端已固定为「0.2.62 产物」，打包直接从
// project/bosom-friend-electron/dist 拷、**不编译源码**。上面的禁词扫描查的是源码——
// 冻结模式下源与产物已解耦，只查源码等于没查"真正交付给用户的那份界面"。
// 冻结模式（存在 FRONTEND-FROZEN.md）下直接校验产物本身：① index.html 的 SHA256 与声明一致；
// ② index.html 引用的 assets 全部存在（2026-09-29 白屏事故：index.html 指着已不存在的文件）。
// 解除冻结（删 FRONTEND-FROZEN.md）后本段自动跳过，回到源码口径。
const FROZEN_MD = join(BASE, '..', 'project', 'bosom-friend-electron', 'FRONTEND-FROZEN.md');
const FROZEN_DIST = join(BASE, '..', 'project', 'bosom-friend-electron', 'dist');
if (existsSync(FROZEN_MD)) {
  const declared = readFileSync(FROZEN_MD, 'utf8').match(/SHA256 前缀 `([0-9A-Fa-f]{8,64})`/)?.[1]?.toUpperCase() ?? '';
  const indexHtml = join(FROZEN_DIST, 'index.html');
  const indexExists = existsSync(indexHtml);
  const digest = indexExists ? createHash('sha256').update(readFileSync(indexHtml)).digest('hex').toUpperCase() : '';
  ok('frozen-产物 index.html 哈希与声明一致', indexExists && declared !== '' && digest.startsWith(declared),
    (indexExists ? 'SHA256=' + digest.slice(0, 12) : '缺 dist/index.html') + '（声明前缀 ' + (declared || '未解析到') + '）');
  let referenced = [];
  if (indexExists) {
    const html = readFileSync(indexHtml, 'utf8');
    // 产物的资源前缀是站点基路径（实测为 `/bosom-friend/assets/...`）。
    referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map(m => m[1])
      .map(p => p.replace(/^\/bosom-friend\//, '').replace(/^\.?\//, ''))
      .filter(p => p.startsWith('assets/'));
  }
  const missingRefs = referenced.filter(rel => !existsSync(join(FROZEN_DIST, rel)));
  ok('frozen-产物引用完整（无悬空 assets）', indexExists && referenced.length > 0 && missingRefs.length === 0,
    indexExists
      ? ('引用 ' + String(referenced.length) + ' 个资源' + (missingRefs.length ? '，缺：' + missingRefs.slice(0, 5).join(', ') : '，全部存在'))
      : '无 index.html');
}
else {
  ok('frozen-模式检测（未冻结时跳过产物校验）', true, '未发现 FRONTEND-FROZEN.md：按源码口径（打包会编译前端）');
}
// ===== 1.5) DEF-237：视频号 POI 外部插件的能力边界（2026-10-13 立） =====
//
// 背景：POI 走**外部浏览器插件**路径（window.ZhiyinPlugin），不经过后端。台账里它长期挂着「待验证」，
// 因为「外部插件是否注入」看上去只能在装了插件的机器上验。本轮把它拆成**两段可自动验** + **一段外部依赖**：
//   ① 静态（本段）：本仓库对 window.ZhiyinPlugin **只有读取、没有注入**——若哪天出现注入赋值，
//      说明插件变成产品自己提供的，这条边界必须重画（这就是断言的价值）；
//   ② 契约（本段）：所有取值点后面**不许直接 `.` 访问属性**（否则插件缺失时抛 TypeError 白屏），
//      只能用可选链或先取值再判空；
//   ③ 运行时（下面第 3 段末尾）：在真实页面里跑探针，证明「没有插件时页面照常加载、取值不抛错」。
// **外部依赖部分（本仓库验不了）**：插件本身是否实现 wxSphSearchLocation / publish。
// 复跑命令（装了插件的 Electron）——给安装版加 --remote-debugging-port=9222，再对同一段探针求值：
//   "C:\\Users\\<you>\\AppData\\Local\\Programs\\Bosom Friend\\Bosom Friend.exe" --remote-debugging-port=9222
//   node -e "fetch('http://127.0.0.1:9222/json/list').then(r=>r.json()).then(l=>console.log(l.map(t=>t.url)))"
// 本机实测（2026-10-13）：安装版启动即退、CDP 未起来（backend 依赖目录缺失，见台账同一行的历史阻塞），
// 因此 Electron 侧运行时探针**当前不可跑**；纯浏览器托管侧的探针见下面的运行时断言。
const PLUGIN_READS = [];
const PLUGIN_WRITES = [];
// 直接属性访问（`window.ZhiyinPlugin.foo`）：插件缺失时必抛。但抛错不等于事故——
// 判据因此分两类**受保护**：① 前面有判空守卫（`!window.ZhiyinPlugin ||` / `?.` / `typeof`）；
// ② 在 `try { }` 块里（抛错被捕获，功能失败但不白屏）。两类都不是则判红。
const PLUGIN_DIRECT = [];
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  const short = f.split('/src/').pop();
  const ls = s.split('\n');
  for (const m of s.matchAll(/window\.ZhiyinPlugin/g)) PLUGIN_READS.push(short);
  if (/window\.ZhiyinPlugin\s*=(?!=)/.test(s)) PLUGIN_WRITES.push(short);
  ls.forEach((line, i) => {
    if (!/window\.ZhiyinPlugin\.[A-Za-z_]/.test(line)) return;
    const before = ls.slice(Math.max(0, i - 25), i + 1).join('\n');
    const guarded = /window\.ZhiyinPlugin\s*[?&|!]/.test(before) || /typeof window\.ZhiyinPlugin/.test(before);
    const inTry = /try\s*\{/.test(before);
    PLUGIN_DIRECT.push({ at: short + ':' + String(i + 1), guarded, inTry });
  });
}
const PLUGIN_UNPROTECTED = PLUGIN_DIRECT.filter(x => !x.guarded && !x.inTry);
ok('DEF-237-插件零注入(静态)', WEB_SRC_EXISTS && PLUGIN_WRITES.length === 0,
  WEB_SRC_EXISTS
    ? ('前端源码里 window.ZhiyinPlugin 取值 ' + String(PLUGIN_READS.length) + ' 处、注入赋值 ' + String(PLUGIN_WRITES.length) + ' 处'
      + (PLUGIN_WRITES.length ? '：' + PLUGIN_WRITES.slice(0, 4).join('; ') : '——插件来自本仓库之外，产品只做消费方'))
    : '未扫描：前端源码目录不存在——这条不能算通过（零注入与否无从判断），先修 static-前端源码目录存在');
ok('DEF-237-插件属性访问有保护(契约)', WEB_SRC_EXISTS && PLUGIN_UNPROTECTED.length === 0,
  WEB_SRC_EXISTS
    ? ('直接属性访问 ' + String(PLUGIN_DIRECT.length) + ' 处，其中判空守卫 ' + String(PLUGIN_DIRECT.filter(x => x.guarded).length)
      + ' 处、try 块内 ' + String(PLUGIN_DIRECT.filter(x => x.inTry && !x.guarded).length) + ' 处'
      + (PLUGIN_UNPROTECTED.length
        ? '；未受保护 ' + String(PLUGIN_UNPROTECTED.length) + ' 处（插件缺失时会抛 TypeError 且无人捕获）：' + PLUGIN_UNPROTECTED.slice(0, 5).map(x => x.at).join('; ')
        : '——插件缺失时要么走判空分支、要么抛错被 try 捕获，都不会白屏'))
    : '未扫描：前端源码目录不存在——这条不能算通过，先修 static-前端源码目录存在');
// ===== 2) i18n 7 语言键一致性 =====
// 源码目录不在时**跳过并说明**：这里读的是前端 i18n 资源，目录没了就没有可比的对象。
// 不静默跳过的部分已经由上面的 static-前端源码目录存在 判红兜住（那一条是总闸）。
if (!WEB_SRC_EXISTS) {
  ok('i18n-route 键七语言同步', false, '跳过：前端源码目录不存在（' + W + '），无法比对 i18n 资源');
} else {
  const langs = ['zh-CN','zh','en','de','fr','ja','ko'];
  const routeKeys = JSON.parse(readFileSync(W + '/app/i18n/locales/zh-CN/route.json', 'utf8'));
  const keyMiss = [];
  for (const l of langs) {
    try { const j = JSON.parse(readFileSync(W + '/app/i18n/locales/' + l + '/route.json', 'utf8')); for (const k of Object.keys(routeKeys)) if (j[k] === undefined) keyMiss.push(l + ':' + k); } catch { keyMiss.push(l + ':file'); }
  }
  ok('i18n-route 键七语言同步', keyMiss.length === 0, keyMiss.slice(0, 6).join('; '));
}
// ===== 3) 运行时防火墙：全新用户视角（清上下文） =====
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext()).newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 100)));
const badReplies = [];
page.on('response', async r => { const u = r.url(); if (!u.includes('/bosom-friend/api')) return; try { const ct = (r.headers()['content-type'] || ''); if (!ct.includes('event-stream')) { const j = await r.json(); if (j && j.code !== 0) badReplies.push(r.request().method() + ' ' + u.split('/bosom-friend/api')[1] + ' code=' + j.code); } } catch { /* non-json */ } });
await page.goto(APP_BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
// DEF-237 运行时探针：纯浏览器托管（无 Electron preload、无外部插件）下，
// 断言「产品不注入插件」且「插件缺失时页面照常加载、取值不抛错」。
// 注意口径：这条断的是**浏览器托管**场景；Electron 壳里的同名探针须另跑（复跑命令见上面 1.5 段注释）。
const def237Probe = await page.evaluate(() => ({
  url: location.href,
  ready: document.readyState,
  plugin: typeof window.ZhiyinPlugin,
  ipc: typeof window.ipcRenderer,
  shim: window.ipcRenderer ? window.ipcRenderer.__zyShim === true : false,
  publish: (() => { try { return typeof (window.ZhiyinPlugin?.publish) } catch { return 'throw' } })(),
  searchLocation: (() => { try { return typeof (window.ZhiyinPlugin?.wxSphSearchLocation) } catch { return 'throw' } })(),
}));
ok('DEF-237-运行时探针(浏览器托管)',
  def237Probe.plugin === 'undefined' && def237Probe.ipc === 'object' && def237Probe.publish === 'undefined' && def237Probe.searchLocation === 'undefined',
  '页面 ' + def237Probe.ready + ' ' + def237Probe.url + '：window.ZhiyinPlugin=' + def237Probe.plugin
  + '、window.ipcRenderer=' + def237Probe.ipc + '（产品 shim=' + String(def237Probe.shim) + '）'
  + '、可选链取值不抛错（ZhiyinPlugin?.publish=' + def237Probe.publish + '、ZhiyinPlugin?.wxSphSearchLocation=' + def237Probe.searchLocation + '）');
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
  let v, scanFailed = false
  try {
    v = await page.evaluate(() => {
      const doc = document.documentElement
      const all = [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0)
      return {
        ox: doc.scrollWidth > doc.clientWidth + 2,
        spinner: [...document.querySelectorAll('[class*=spinner]')].filter(e => e.offsetHeight > 0).length > 2,
        len: document.body.innerText.length,
        broken: all.map(i => i.currentSrc || i.src || ''),
      }
    })
  } catch (e) { scanFailed = true; v = { ox: false, spinner: false, len: 0, broken: [] } }
  const pageOrigin = new URL(APP_BASE).origin
  const brokenLocal = v.broken.filter(s => classifyImgUrl(s, pageOrigin) === 'local')
  const brokenExternal = v.broken.filter(s => classifyImgUrl(s, pageOrigin) === 'external')
  const jr = judgeLayout({ ox: v.ox, spinner: v.spinner, len: v.len, brokenLocal: brokenLocal.length, brokenExternal: brokenExternal.length, scanFailed })
  ok('LAYOUT-' + rr, jr.pass, 'ox=' + v.ox + ' broken_local=' + brokenLocal.length + ' broken_external=' + brokenExternal.length + ' len=' + v.len + (jr.reason ? ' reason=' + jr.reason : ''))
  // 外部依赖告警：只记来源主机，不写完整 URL
  if (jr.warning) console.log('WARN ' + jr.warning + ' @' + rr + ' hosts=' + [...new Set(brokenExternal.map(externalHostOnly))].join(','));
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
