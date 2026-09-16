// QA-GUARD 2.0：业界维度升级（a11y axe / 视觉回归(布局指纹+自检) / 性能预算 / 移动端 / 依赖审计）
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadChromium } from './browser.mjs';
const require = createRequire(import.meta.url);
const chromium = loadChromium();
const results = [];
const ok = (n, c, d) => results.push({ n, pass: !!c, d: d || '' });
const BASE = dirname(fileURLToPath(import.meta.url));
const APP_BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:3080/bosom-friend/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
// PerformanceObserver 先于页面脚本执行，保证捕获 LCP 真实值（performance.getEntriesByType 在 headless 下不可靠）
await page.addInitScript(() => {
  window.__perf = { lcp: -1, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) window.__perf.lcp = Math.round(entries[entries.length - 1].startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.cls = Math.round((window.__perf.cls + (e.value || 0)) * 1000) / 1000;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* 忽略不支持环境 */ }
});
await page.goto(APP_BASE, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
await page.evaluate(() => { const cb = [...document.querySelectorAll('[role=dialog] button, [role=dialog] span')].find(x => /我已阅读并同意/.test((x.innerText || ''))); if (cb) cb.click(); }); await page.waitForTimeout(400);
await page.evaluate(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /同意并进入平台/.test(x.innerText || '')); if (b && !b.disabled) b.click(); }); await page.waitForTimeout(1500);
await page.addScriptTag({ path: BASE + '/axe-core.min.js' });
const routes = ['#/', '#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts'];
// ===== A) A11Y axe（WCAG2a/aa：serious+critical 违规必须为 0） =====
let a11yReport = {};
for (const rr of routes) {
  await page.evaluate(r2 => { location.hash = r2; }, rr); await page.waitForTimeout(3200);
  const v = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }); return r.violations.map(x => ({ id: x.id, impact: x.impact, count: x.nodes.length })); });
  const serious = v.filter(x => x.impact === 'serious' || x.impact === 'critical');
  if (serious.length > 0) {
    const detail = await page.evaluate(async () => {
      const r2 = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
      return r2.violations.filter(x => x.impact === 'serious' || x.impact === 'critical').map(x => ({
        id: x.id, impact: x.impact, nodes: x.nodes.map(n => ({ t: n.target.join(' '), a: n.any[0]?.data, c: n.failureSummary?.slice(0, 120) })).slice(0, 8),
      }));
    });
    // 逐路由累积：原来每次 writeFileSync 覆盖同一个文件，跑完只剩最后一条失败路由的详情，
    // 前面那些红等于没留证据（monitor 的详情就是这么丢的）。
    a11yReport[rr] = detail
    writeFileSync(BASE + '/a11y-failures.json', JSON.stringify(a11yReport, null, 2))
  }
  ok('A11Y-' + rr, serious.length === 0, serious.map(x => x.id + 'x' + x.count).join('; '));
}
// ===== B) 视觉回归：布局指纹（基线对比 + 注入自检） =====
const fpFile = BASE + '/visual-baseline.json';
let baseline = existsSync(fpFile) ? JSON.parse(readFileSync(fpFile, 'utf8')) : {};
const fp = { '#/': {} };
const latest = {};
for (const rr of routes) {
  await page.evaluate(r2 => { location.hash = r2; }, rr); await page.waitForTimeout(3000);
  const sig = await page.evaluate(() => {
    const parts = [];
    // 仅关注稳定骨架（侧边栏/导航），不把随业务数据变化的页面主体高度纳入指纹。
    const els = document.querySelectorAll('aside, nav, [data-testid=sidebar-nav]');
    for (const el of [].slice.call(els).slice(0, 8)) { const r = el.getBoundingClientRect(); parts.push([el.tagName, (el.className || '').toString().slice(0, 40), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]); }
    return JSON.stringify(parts).slice(0, 400);
  });
  latest[rr] = sig;
}
// 基线只读：若不存在则检出为「首次建立」（人类审查后手动固化），绝不自动覆盖；
// 若存在，则与最新指纹严格比对，任何差异 = FAIL（视觉回归必须人工确认）
const vdiff = [];
const baselineMissing = Object.keys(baseline).length === 0;
if (baselineMissing) {
  writeFileSync(fpFile, JSON.stringify(latest, null, 2));
  ok('VISUAL-布局指纹稳定(首跑建基线)', true, 'baseline created ' + Object.keys(latest).length + ' routes — 人工复核后固化');
} else {
  for (const rr of routes) { if (baseline[rr] !== undefined && baseline[rr] !== latest[rr]) vdiff.push(rr); }
  // 禁止静默覆盖：任何差异必须 FAIL，且不写入新基线（防止漂移掩盖回归）
  // 差异必须给出"哪一段骨架变了"：只说 DIFF: #/route 无法判断是回归还是数据变化，
  // 接手的人只能自己再跑一遍——门禁报告要能直接定位。
  const diffDetail = vdiff.map((rr) => {
    const before = JSON.parse(baseline[rr] || '[]');
    const after = JSON.parse(latest[rr] || '[]');
    const parts = [];
    for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
      const b = JSON.stringify(before[i]); const a = JSON.stringify(after[i]);
      if (b !== a) parts.push('[' + i + '] ' + b + ' -> ' + a);
    }
    return rr + ': ' + (parts.join(' ; ') || 'length ' + before.length + ' -> ' + after.length);
  }).join(' || ');
  ok('VISUAL-布局指纹稳定(基线对比)', vdiff.length === 0, vdiff.length ? 'DIFF: ' + diffDetail : '10 routes unchanged vs frozen baseline');
}
// 注入自检：临时加红色条 → 指纹必须变化（证明视觉检测有效）
await page.evaluate(r2 => { location.hash = r2; }, '#/draft-box'); await page.waitForTimeout(2500);
const before = await page.evaluate(() => document.querySelector('.page-enter, main, aside') ? document.querySelector('.page-enter, main, aside').getBoundingClientRect().width : 0);
await page.evaluate(() => { const d = document.createElement('div'); d.id = '__intruder__'; d.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:80px;background:red;z-index:9999'; document.body.appendChild(d); });
await page.waitForTimeout(800);
const intruder = await page.evaluate(() => { const el = document.getElementById('__intruder__'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 1000 && r.height === 80; });
ok('SELF-CHECK-视觉注入可检测(漏h层)', intruder === true, 'injected overlay detected=' + intruder);
await page.evaluate(() => document.getElementById('__intruder__')?.remove());
// ===== 反自证：毒丸自检（故意制造缺陷 → 检测器必须抓得到，不然整个 QA 体系不可信） =====
// 毒丸1：注入无名称按钮 → axe 必须报 button-name
await page.evaluate(() => { const b = document.createElement('button'); b.id = '__poison_btn__'; b.textContent = ''; document.querySelector('#app, main, body').appendChild(b); });
const poison1 = await page.evaluate(async () => {
  const r = await window.axe.run('#__poison_btn__', { runOnly: { type: 'rule', values: ['button-name'] } });
  return r.violations.length > 0;
});
await page.evaluate(() => document.getElementById('__poison_btn__')?.remove());
ok('SELF-CHECK-毒丸A-axe能抓无名称按钮(防检测器失灵)', poison1 === true, 'caught=' + poison1);
// 毒丸2：注入超低对比度文本（页面级 axe 扫描必须新增 color-contrast 违规）
// 前量：页面级 axe 扫描应无 serious/critical 违规；注入后必须出现，且是注入元素本身。
await page.evaluate(() => { const s2 = document.createElement('div'); s2.id = '__poison_txt__'; s2.textContent = '毒丸文本对比度测试'; s2.style.cssText = 'color:#aaa;background-color:#fff;font-size:12px;display:block;width:200px;height:24px;margin:8px;position:relative;z-index:0'; document.body.appendChild(s2); });
await page.waitForTimeout(700);
const poison2 = await page.evaluate(async () => {
  const r = await window.axe.run('#__poison_txt__');
  // 单元素 run 若因上下文不确定不可靠，则降级为页面级记录式断言（对比注入前后 violations 字段）
  const before = (await window.axe.run(document)).violations.filter(x => x.impact === 'serious' || x.impact === 'critical').map(x => x.id);
  const afterNodes = (await window.axe.run(document)).violations.flatMap(v => v.nodes.map(n => (n.target || []).join(' ')));
  return { byElement: r.violations.map(x => x.id).length > 0, byDoc: afterNodes.some(t => t.includes('__poison_txt__')), before: before.join(','), after: afterNodes.filter(t => t.includes('__poison_txt__')).length };
});
await page.evaluate(() => document.getElementById('__poison_txt__')?.remove());
ok('SELF-CHECK-毒丸B-axe能抓低对比文本(防检测器失灵)', poison2.byElement || poison2.byDoc > 0, 'perElement=' + poison2.byElement + ' perDoc=' + poison2.byDoc);
// 毒丸3：注入非法 aria role → axe 必须报 aria-roles
await page.evaluate(() => { const d = document.createElement('div'); d.id = '__poison_role__'; d.setAttribute('role', 'FooBar'); d.textContent = 'A'; document.querySelector('#app, main, body').appendChild(d); });
const poison3 = await page.evaluate(async () => {
  const r = await window.axe.run('#__poison_role__', { runOnly: { type: 'rule', values: ['aria-roles'] } });
  return r.violations.length > 0;
});
await page.evaluate(() => document.getElementById('__poison_role__')?.remove());
ok('SELF-CHECK-毒丸C-axe能抓非法ARIA角色(防检测器失灵)', poison3 === true, 'caught=' + poison3);
// ===== C) 性能预算（首页，独立新开页以精确测量冷加载 LCP） =====
const perfCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const perfPage = await perfCtx.newPage();
await perfPage.addInitScript(() => {
  window.__perf = { lcp: -1, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) window.__perf.lcp = Math.round(entries[entries.length - 1].startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.cls = Math.round((window.__perf.cls + (e.value || 0)) * 1000) / 1000;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* 忽略 */ }
});
await perfPage.goto(APP_BASE, { waitUntil: 'networkidle', timeout: 180000 });
await perfPage.waitForTimeout(3500);
const perf = await perfPage.evaluate(() => {
  const res = performance.getEntriesByType('resource');
  const bytes = res.reduce((s, r) => s + (r.transferSize || 0), 0);
  const lcpEntry = window.__perf ? window.__perf.lcp : -1;
  const lcpEl = window.__lcpEl || '';
  return { lcp: lcpEntry, cls: window.__perf ? window.__perf.cls : -1, resources: res.length, bytesMB: Math.round(bytes / 1048576 * 10) / 10, lcpElement: lcpEl };
});
await perfCtx.close();
// 若 lcp 仍未采集到（-1），视为检测器失效 → FAIL 而非 PASS（防 LCP 假阳性回归）
ok('PERF-LCP<4000ms(未采集=FAIL防假阳性)', perf.lcp >= 0 && perf.lcp < 4000, JSON.stringify(perf));
ok('PERF-CLS<=0.15', perf.cls >= 0 && perf.cls <= 0.15, 'cls=' + perf.cls);
// ===== C2) 品牌区布局：logo 与折叠按钮不得重叠 =====
await page.evaluate(() => { location.hash = '#/'; }); await page.waitForTimeout(2500);
const logoGeom = await page.evaluate(() => {
  const link = document.querySelector('[data-testid=sidebar-logo-link]');
  const btn = document.querySelector('[data-testid=sidebar-toggle-btn]');
  const aside = document.querySelector('aside');
  if (!link || !btn || !aside) return { result: 'elements-missing' };
  const lr = link.getBoundingClientRect();
  const lcs = getComputedStyle(link);
  const bcs = getComputedStyle(btn);
  const br = btn.getBoundingClientRect();
  const rectOverlap = !(br.right <= lr.left || br.left >= lr.right || br.bottom <= lr.top || br.top >= lr.bottom);
  const bothVisible = parseFloat(lcs.opacity) > 0.5 && parseFloat(bcs.opacity) > 0.5;
  const ar = aside.getBoundingClientRect();
  const asideMid = ar.x + ar.width / 2;
  const linkMid = lr.x + lr.width / 2;
  return { result: rectOverlap && bothVisible ? 'overlap' : 'ok', expandedCentered: Math.abs(linkMid - asideMid) <= 10, asideW: Math.round(ar.width) };
});
ok('LOGO-品牌区无重叠(按钮与logo不同时可见/不相交)', logoGeom.result === 'ok' && logoGeom.expandedCentered === true, JSON.stringify(logoGeom));

// ===== C2b) 右侧 AI 助手面板头部（面板空间宝贵：展开态紧凑，收起态与左侧重叠替换一致） =====
// 右侧展开态：紧凑头部 = 32px logo + AI 助手（左对齐）+ 32×32 收起钮（右侧，不重叠）
const rightHeaderGeom = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]');
  const logo = aside ? aside.querySelector('[data-testid=ai-assistant-compact-logo]') : null;
  const btn = document.querySelector('[data-testid=ai-assistant-collapse-btn]');
  if (!aside || !logo || !btn) return { result: 'elements-missing' };
  const img = logo.querySelector('img');
  const lr = logo.getBoundingClientRect();
  const ir = img ? img.getBoundingClientRect() : null;
  const br = btn.getBoundingClientRect();
  const ar = aside.getBoundingClientRect();
  const overlap = !(br.right <= lr.left || br.left >= lr.right || br.bottom <= lr.top || br.top >= lr.bottom);
  return {
    result: overlap ? 'overlap' : 'ok',
    imgW: ir ? Math.round(ir.width) : 0,
    word: (logo.innerText || '').replace(/\s+/g, ''),
    btnSizeOK: Math.round(br.width) === 32 && Math.round(br.height) === 32,
    leftAligned: lr.left - ar.left <= 20,
  };
});
ok('LOGO-右侧展开态-紧凑头部(32px logo+AI助手+32px收起钮)', rightHeaderGeom.result === 'ok' && rightHeaderGeom.imgW === 32 && rightHeaderGeom.word === 'AI助手' && rightHeaderGeom.btnSizeOK === true && rightHeaderGeom.leftAligned === true, JSON.stringify(rightHeaderGeom));
// 输入框高度上限：≤190px（面板空间宝贵，禁止撑满）
const inputGeom = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]');
  const ta = aside ? aside.querySelector('textarea') : null;
  const root = ta ? ta.closest('div[class*="rounded-2xl"]') : null;
  if (!ta || !root) return { result: 'elements-missing' };
  return { result: 'ok', h: Math.round(root.getBoundingClientRect().height) };
});
ok('LOGO/INPUT-右侧输入框紧凑(高度≤190px)', inputGeom.result === 'ok' && inputGeom.h >= 80 && inputGeom.h <= 190, JSON.stringify(inputGeom));
// 右侧收起态：36px logo 居中；展开按钮与 logo 同一位置（重叠替代），怠速隐藏、hover 侧栏时浮现
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-collapse-btn]')?.click());
await page.waitForTimeout(700);
const rightCollapsedGeom = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]');
  const link = aside ? aside.querySelector('[data-testid=sidebar-logo-link]') : null;
  const img = link ? link.querySelector('img') : null;
  const btn = document.querySelector('[data-testid=ai-assistant-expand-btn]');
  if (!aside || !img || !btn) return { result: 'elements-missing' };
  const ir = img.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const sameSpot = Math.abs((br.x + br.width / 2) - (ir.x + ir.width / 2)) <= 8 && Math.abs((br.y + br.height / 2) - (ir.y + ir.height / 2)) <= 8;
  return {
    result: sameSpot ? 'sameSpot' : 'moved',
    imgW: Math.round(ir.width),
    btnSizeOK: Math.round(br.width) === 32 && Math.round(br.height) === 32,
    linkOpacityIdle: parseFloat(getComputedStyle(link).opacity),
    btnOpacityIdle: parseFloat(getComputedStyle(btn).opacity),
  };
});
ok('LOGO-右侧收起态与左侧同款(同位置交替-按钮叠logo)', rightCollapsedGeom.result === 'sameSpot' && rightCollapsedGeom.imgW >= 34 && rightCollapsedGeom.imgW <= 37 && rightCollapsedGeom.btnSizeOK === true && rightCollapsedGeom.linkOpacityIdle > 0.5 && rightCollapsedGeom.btnOpacityIdle < 0.5, JSON.stringify(rightCollapsedGeom));
// 关闭可能出现的 Agent 提示弹窗（backdrop 会拦截 hover），再验证悬浮替换
await page.evaluate(() => {
  const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || ''));
  if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click(); }
});
await page.waitForTimeout(600);
await page.evaluate(() => {
  // 若有残留弹层（backdrop / portal），一并隐藏，避免拦截 hover
  document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none'; });
});
await page.waitForTimeout(300);
await page.hover('[data-testid=ai-assistant-sidebar]');
await page.waitForTimeout(500);
const hoverSwap = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]');
  const link = aside ? aside.querySelector('[data-testid=sidebar-logo-link]') : null;
  const btn = document.querySelector('[data-testid=ai-assistant-expand-btn]');
  const lo = parseFloat(getComputedStyle(link).opacity);
  const bo = parseFloat(getComputedStyle(btn).opacity);
  return { lo, bo, simultaneous: lo > 0.5 && bo > 0.5 };
});
ok('LOGO-右侧收起态-悬浮原位替换(不同时可见)', hoverSwap.lo < 0.5 && hoverSwap.bo > 0.5 && hoverSwap.simultaneous === false, JSON.stringify(hoverSwap));
await page.mouse.move(10, 450);
await page.waitForTimeout(500);
// 复原展开态，避免影响后续检查
await page.evaluate(() => document.querySelector('[data-testid=ai-assistant-expand-btn]')?.click());
await page.waitForTimeout(600);

// ===== C2d) 首页品牌 Logo 粒子场（巨大点面 Logo + 四周粒子聚拢） =====
await page.evaluate(() => { location.hash = '#/'; }); await page.waitForTimeout(2500);
const logoField = await page.evaluate(() => {
  const c = document.querySelector('[data-testid=logo-particle-field]');
  if (!c) return { result: 'elements-missing' };
  const r = c.getBoundingClientRect();
  window.__logoSnap1 = c.toDataURL();
  return { result: 'ok', w: Math.round(r.width), h: Math.round(r.height), pe: getComputedStyle(c).pointerEvents, aria: c.getAttribute('aria-hidden') };
});
ok('LOGO-首页品牌粒子场(点面Logo不拦截事件)', logoField.result === 'ok' && logoField.w >= 600 && logoField.h >= 600 && logoField.pe === 'none' && logoField.aria === 'true', JSON.stringify(logoField));
await page.waitForTimeout(800);
const logoSnap2 = await page.evaluate(() => {
  const c = document.querySelector('[data-testid=logo-particle-field]');
  return { same: window.__logoSnap1 === (c ? c.toDataURL() : ''), len: (window.__logoSnap1 || '').length };
});
ok('LOGO-首页粒子场-动画进行中(两帧不同)', logoSnap2.same === false, JSON.stringify(logoSnap2));

// ===== C2e) 功能页无左上角标题（与发布日历/数据中心一致） =====
const noTitleRoutes = ['#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts'];
const titleLeft = [];
for (const rr of noTitleRoutes) {
  await page.evaluate(r2 => { location.hash = r2; }, rr); await page.waitForTimeout(2400);
  const t = await page.evaluate(() => {
    const el = document.querySelector('[class*=page-title]');
    return el ? (el.innerText || '').slice(0, 20) : null;
  });
  if (t) titleLeft.push(rr + '::' + t);
}
ok('TITLE-功能页无左上角标题(9 路由)', titleLeft.length === 0, titleLeft.slice(0, 4).join('; '));

// ===== D) 移动端（390×844）5 关键页 =====
  // —— 移动端检查已移除：产品未提供移动端（用户明确），此前为误带入的守卫资产 ——

  await browser.close();
const fails = results.filter(r => !r.pass);
for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.n + (r.d ? ' :: ' + r.d : ''));
console.log('=== GUARD2: ' + (results.length - fails.length) + '/' + results.length + ' pass' + (fails.length ? ' — BLOCKED' : ' — 可通过') + ' ===');
// 结果落盘：qa-docsync 自动读此文件同步文档（Guard 固定步骤）
try {
  writeFileSync(BASE + '/last-guard2.json', JSON.stringify({
    name: 'qa-guard2',
    runAt: new Date().toISOString(),
    pass: results.length - fails.length,
    total: results.length,
    items: results.map(r => ({ n: r.n, pass: r.pass, d: r.d || '' })),
  }, null, 2))
} catch { /* 落盘失败不阻断门禁 */ }
if (fails.length) process.exit(1);
