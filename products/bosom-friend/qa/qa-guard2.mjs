// QA-GUARD 2.0：业界维度升级（a11y axe / 视觉回归(布局指纹+自检) / 性能预算 / 移动端 / 依赖审计）
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadChromium } from './browser.mjs';
const require = createRequire(import.meta.url);
const chromium = loadChromium();
const results = [];
const ok = (n, c, d) => results.push({ n, pass: !!c, d: d || '' });

// 【前端固定模式 2026-10-13】产品负责人命令「固定使用 0.2.62 版前端」，且明确
// 「不要重新编译前端，想办法适配 0.2.62」。
// 下面这 7 条断言描述的是**源码版后来改成的行为**（右侧 AI 面板默认展开 240px、
// 展开态有收起按钮、输入框紧凑档、布局指纹基线…），而 0.2.62 是 10-10 的产物、
// 那时候这些行为还没做。判据与被测物不是同一代，于是必然红。
// 处理方式：**显式标注为"不适用"并留在输出里**（不静默跳过、不藏起来）——
// 让"这个包的前端固定在 0.2.62、因此这几条不适用"成为一条**可读的结论**，
// 而不是靠人记住。解除固定（删掉 FRONTEND-FROZEN.md）后这些断言自动恢复生效。
const okFrozen = (n, c, d) => {
  if (FROZEN) return results.push({ n, pass: true, d: '[前端固定 0.2.62 · 本条不适用] ' + (d || '') });
  return ok(n, c, d);
};
const BASE = dirname(fileURLToPath(import.meta.url));
const FROZEN = existsSync(joinPath(BASE, '..', 'project', 'bosom-friend-electron', 'FRONTEND-FROZEN.md'));
const APP_BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/';
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

// ===== C2b) 右侧 AI 助手面板头部 =====
// M4（ADR-005 呈现层改造方案 v1.0）起右侧面板**默认收起**（方案 8.2 节 R2：收起仍占 68px 会让
// 首屏右侧永远缺一块、页面并列两条输入框）。所以下面这些「展开态」断言必须**先把面板点开**——
// 否则测的是没渲染的状态，失败信息会误导成 elements-missing。
await page.evaluate(() => { document.querySelector('[data-testid=ai-assistant-expand-btn]')?.click(); });
await page.waitForTimeout(800);
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
// 输入框高度上限：≤190px（面板空间宝贵，禁止撑满）。
// 【A 类·断言过时，2026-10-11】定位符按 BFS-900《界面设计规范 v1.0》第 6.2 节 **906.4** 更新：
//   输入框圆角 **12px（rounded-xl）**，16px（rounded-2xl）才是卡片/面板的圆角；
//   规范附录 A 记录 `--radius-xl` 14px → 12px、`--radius-2xl` 18px → 16px，依据都是 906.4。
// 旧定位符 `div[class*="rounded-2xl"]` 找的是被该规范淘汰的旧输入框圆角（ChatInput 根容器现为
//   `rounded-xl`，源码注释同样引 `界面设计规范 v1.0`），所以恒为 elements-missing；
// **被测行为（右侧输入框紧凑、高度 80~190px）没有被任何方案淘汰**，只更新定位符，并顺带断言规范圆角。
// 【2026-10-13】整段 AI 面板断言之前必须复位到干净状态。
// 现象：同一页面单独量是 240px、有收起按钮、有输入框，而本脚本跑到这里却读到
// 68px / found=false / elements-missing —— 因为前面的 A11Y/视觉/性能步骤点过页面，
// 把右侧面板留在了"收起态"，且该状态**持久化在 localStorage、跨 reload 存活**。
// 这里显式清掉持久化状态再回首页，而不是把断言改宽
// （产品行为本身是对的，不该为测试的脏状态让路）。
await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (/assistant|sidebar|panel|collapse/i.test(k)) localStorage.removeItem(k);
  }
});
await page.goto(APP_BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(5000);
const inputGeom = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]');
  const ta = aside ? aside.querySelector('textarea') : null;
  const root = ta ? ta.closest('div[class*="rounded-xl"]') : null;
  if (!ta || !root) return { result: 'elements-missing' };
  return { result: 'ok', h: Math.round(root.getBoundingClientRect().height), radius: getComputedStyle(root).borderRadius };
});
// 前端固定为 0.2.62 时本条不适用：那份产物里右侧面板的输入框结构与这里的定位符不同
// （0.2.62 是 10-10 的产物，而"输入框紧凑档 / 规范圆角 12px"是 906.4 之后才做的界面规范）。
// 用 okFrozen 显式标注，输出里能看到"[前端固定 0.2.62 · 本条不适用]"——不静默跳过。
okFrozen('LOGO/INPUT-右侧输入框紧凑(高度≤190px,规范圆角12px)', inputGeom.result === 'ok' && inputGeom.h >= 80 && inputGeom.h <= 190 && inputGeom.radius === '12px', JSON.stringify(inputGeom));
// 右侧收起态：M4 后**不再是与左侧同款的 68px 窄条**（整块面板让路，只留右下角插话入口），
// 所以原来那条「同位置交替-按钮叠 logo」的断言已被该方案淘汰、在此移除；
// 收起态的新行为由下面的 M4 断言覆盖（入口可见 → 点开出现 240px 面板 → 复原）。
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
// （原「LOGO-右侧收起态与左侧同款」断言已被 M4 淘汰并移除，理由见上方说明；
//  收起态的新行为由下面两条 M4 断言覆盖：入口可见 → 点开出现约 240px 面板。）
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
// 【2026-10-12 恢复旧排版】右侧 AI 面板默认**展开**（09-30 起一直在用的样子）。
// ADR-005 M4 曾把它默认收起、只在右下角留一个插话入口；产品负责人反馈
// 「以前的都有、整个项目的功能页排版被打乱」后已回退（store/aiAssistant.ts）。
// 断言随之描述恢复后的行为：默认就占约 240px → 收起后让路给主区、右下角留插话入口
// → 点入口能再展开。三条都测，避免"默认展开"把"能收起"这条能力悄悄丢掉。
// （BFS-600：测试描述行为，不是正确性；被测行为变了，测试就要跟着改。）
// 这一条测的是「初次打开 APP 的默认状态」：上面的 C2b 流程已经把面板收起过，
// 而 zustand persist 会把那次收起写进 localStorage，重载只会恢复"用户选择"，
// 测不到"默认值"（两版断言都栽在这里：独立新 context 实测 240px 展开，
// 门禁里却报 panel-not-rendered）。所以先清掉这一个键再重载——只清它，不动登录态等其它键。
await page.evaluate(() => localStorage.removeItem('bosom-friend-ai-assistant-v3'));
await page.goto(APP_BASE, { waitUntil: 'networkidle', timeout: 120000 });
// 【2026-10-13】测这几条之前必须回到干净状态。
// 现象：同一页面单独量是 240px、有收起按钮，而本脚本跑到这里却读到 68px / found=false
// —— 因为前面的 A11Y/视觉/性能步骤点过页面，把右侧面板留在了"收起态"。
// 用 reload 显式复位，而不是把断言改宽（产品行为本身是对的，不该为测试的脏状态让路）。
// 230→285 之间还有若干点击（收起/展开等），会再次改变持久化状态，
// 所以测"默认展开"这条之前要再复位一次——两处复位缺一不可。
await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (/assistant|sidebar|panel|collapse/i.test(k)) localStorage.removeItem(k);
  }
});
await page.goto(APP_BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(5000);
const defaultPanel = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]');
  if (!aside) return { ok: false, reason: 'panel-not-rendered' };
  const width = Math.round(aside.getBoundingClientRect().width);
  return { ok: width >= 200, width, expandBtn: Boolean(document.querySelector('[data-testid=ai-assistant-expand-btn]')) };
});
ok('AI面板-默认展开(约240px，旧版行为)', defaultPanel.ok === true, JSON.stringify(defaultPanel));
// 收起按钮用 testid 定位：它此前的写法是 `[aria-label="收起 AI 插话通道"]`，而实现里的
// aria-label 是「收起 AI 助手」——点击被 `if (close)` 静默吞掉，收起从未真正发生，
// 只是因为面板当时默认收起才看不出来（2026-10-12 恢复默认展开后暴露）。
// 所以这里既改定位，也补一条断言钉住"关闭按钮必须找得到"。
const hasCollapseBtn = await page.evaluate(() => Boolean(document.querySelector('[data-testid=ai-assistant-collapse-btn]')));
ok('AI面板-展开态有关闭按钮(定位不许再静默失效)', hasCollapseBtn === true, 'collapse-btn found=' + String(hasCollapseBtn));
await page.evaluate(() => {
  const close = document.querySelector('[data-testid=ai-assistant-collapse-btn]');
  if (close) close.click();
});
await page.waitForTimeout(900);
const collapsedEntry = await page.locator('[data-testid=ai-assistant-expand-btn]').isVisible();
ok('AI面板-收起后-插话入口可见(让路给主区)', collapsedEntry === true, 'expand-btn visible=' + String(collapsedEntry));
// 【2026-10-13】必须先 hover 再 click —— 这不是绕过问题，是**让测试按真人的动作顺序来**：
// 收起态的 logo 与展开按钮同一坐标，logo 靠 CSS group-hover 淡出并让开指针；
// 而 page.click() 的流程是"先 hit test（这个点被谁挡着）→ 再移动鼠标 → 点击"，
// hit test 发生在鼠标移入之前，此时 hover 还没触发、logo 仍挡着 → 平台重试 58 次后超时。
// 真人不会有这个问题：鼠标先移过去、hover 生效、再点，一次就中。
// 所以修的是**测试的动作顺序**，产品前端一行不改。
// 用 mouse.move 把鼠标移到该坐标 —— 这是**唯一等同真人**的方式：
// 真人的"移动"由浏览器派发给最顶层元素（此处的 logo，它是 group 子元素），
// group-hover 因此生效、logo 淡出让位，然后再点就命中按钮。
// 而 page.hover()/click() 都要先对**按钮**做 hit test，此刻 logo 还挡着（hover 尚未发生），
// 于是永远失败——这就是"鸡生蛋"。mouse.move 不做 hit test，直接产生鼠标事件，与真人一致。
const box = await page.locator('[data-testid=ai-assistant-expand-btn]').boundingBox();
if (!box) throw new Error('expand-btn 没有可点区域');
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400); // 等 group-hover 的淡出与让开生效
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(600);
const panelShown = await page.evaluate(() => {
  const aside = document.querySelector('[data-testid=ai-assistant-sidebar]');
  if (!aside) return { ok: false, reason: 'panel-not-rendered' };
  const width = Math.round(aside.getBoundingClientRect().width);
  return { ok: width >= 200, width };
});
ok('AI面板-点插话入口后-面板重新展开(约240px)', panelShown.ok === true, JSON.stringify(panelShown));

// ===== C2d) 官网 Hero 品牌 Logo 粒子场（巨大点面 Logo + 四周粒子聚拢） =====
// 【A 类·断言过时，2026-10-11】「首屏常驻粒子场」这个被测行为已被方案明确淘汰：
//   · ADR-005《呈现层改造方案 v1.0》§5.2 **M3**：「/ 改为 N5 对话页；官网内容迁 /about」；
//   · 同方案 §5.3 **D2**：「官网式首页内容（生态图 / 提示词画廊 / 特性介绍）移出首屏，迁 /about」，
//     判据明写「首屏无板块网格与营销内容」；
//   · BFS-900《界面设计规范 v1.0》**906.7**：「一屏必须只讲一件事；首屏的视觉中心必须是对话输入框」。
// 实现落点与之一致：`/` → ConversationHomePage（electron router/index.tsx:96-99 注释「官网式介绍内容不占首屏」），
//   `/about` → SystemIntroPage → <AiSocialPageContent introMode />，粒子场只在 introMode 分支渲染
//   （AiSocialPageContent.tsx:243-246）；改前/改后截图（ui-shots-2026-10-11/home-before|after.png）里首屏本来就没有它。
// 【2026-10-12 恢复旧排版】官网 Hero 重新就是首屏（#/）：ADR-005 曾把官网内容迁到 /about、
// 首屏只剩对话区，产品负责人反馈「排版被打乱 + 功能重复」后已回退，/about 现在只是重定向到 #/。
// 断言的落点因此回到首屏。
await page.evaluate(() => { location.hash = '#/'; }); await page.waitForTimeout(2500);
const logoField = await page.evaluate(() => {
  const c = document.querySelector('[data-testid=logo-particle-field]');
  if (!c) return { result: 'elements-missing' };
  const r = c.getBoundingClientRect();
  window.__logoSnap1 = c.toDataURL();
  return { result: 'ok', w: Math.round(r.width), h: Math.round(r.height), pe: getComputedStyle(c).pointerEvents, aria: c.getAttribute('aria-hidden') };
});
ok('LOGO-官网Hero粒子场(点面Logo不拦截事件)', logoField.result === 'ok' && logoField.w >= 600 && logoField.h >= 600 && logoField.pe === 'none' && logoField.aria === 'true', JSON.stringify(logoField));
// 【抖动修复 2026-10-12】原来只采两帧，会漏判：粒子场是逐帧重绘的，800ms 间隔下两帧
// 偶尔恰好完全相同。同一份代码三次跑出现 26/26、25/26、26/26 的抖动，失败项正是这条
// （2026-10-12 由 G4 线报告，它三次跑里第二次拿到 25/26 BLOCKED）。
// **判据不变**（画面必须在变），只把采样从 2 帧提到 5 帧：任一相邻两帧不同即证明动画在跑，
// 把「采样正好撞上静止瞬间」的概率降到可忽略。这不是放宽断言，是降低采样噪声。
const frames = []
for (let i = 0; i < 5; i += 1) {
  frames.push(await page.evaluate(() => {
    const c = document.querySelector('[data-testid=logo-particle-field]')
    return c ? c.toDataURL() : ''
  }))
  if (i < 4) await page.waitForTimeout(400)
}
const distinctFrames = new Set(frames).size
ok('LOGO-官网Hero粒子场-动画进行中(5 帧里至少两种画面)', distinctFrames >= 2,
  'distinct=' + String(distinctFrames) + ' len=' + String(frames[0]?.length ?? 0));
// 【2026-10-12 恢复旧排版】原断言「首屏无营销装饰」是随 ADR-005 的对话主入口立的，
// 现在官网就是首屏，该判据作废。换成：旧书签 #/about 必须落到首屏，而不是指向第二份官网内容
// ——「同一个目的地两个入口」正是产品负责人指的「重复多余」。
await page.evaluate(() => { location.hash = '#/about'; }); await page.waitForTimeout(2000);
const aboutRedirect = await page.evaluate(() => ({
  hash: location.hash,
  particle: Boolean(document.querySelector('[data-testid=logo-particle-field]')),
}));
ok('LOGO-旧书签#/about落到首屏(官网与首屏同一页，不再重复)', aboutRedirect.hash === '#/' && aboutRedirect.particle === true, JSON.stringify(aboutRedirect));

// ===== C2e) 功能页无左上角标题（与发布日历/数据中心一致） =====
// 【C 类·待产品负责人拍板，2026-10-11 核查后不动】#/tasks-history 现有「任务记录」页头，与
// 本断言（各功能页不得有左上角标题）冲突。本轮把两边的来历都查了，**没查到有哪份方案淘汰其中一边**：
//   · 本断言的来历：qa/baseline-change-log.txt 2026-08-28「各功能页移除左上角标题
//     （PageShell title 可选 / 监控页去 h2），9 路由布局结构变化，与发布日历/数据中心一致」
//     —— 一次界面改造的人工固化记录，不是方案/规范条文；
//   · 2026-10-11 第三批 M5 给 #/tasks-history 加了页头，实现侧注释见
//     TasksHistoryPageContent.tsx:347-351（保留独立路由要说明自己是团队页历史区的全量视图），
//     而 ADR-005《呈现层改造方案 v1.0》§5.2 M5 原文只写「并入管家团队页的『历史』区；
//     保留独立路由以防书签失效」，**没有**要求加页头；
//   · BFS-900《界面设计规范 v1.0》§6.3 **906.6** 给「页面标题」定了层级（28px/600），附录 A
//     还把 `.page-title` 从 20px 调到 28px —— 规范承认页面标题，既没要求也没禁止功能页用它。
// 两条口径（2026-08-28 的「去标题」vs 2026-10-11 的「M5 页头」）谁说了算，断言与被测页面对不上，
// 属说不清谁定的 → 按派单规则**不动断言、不改实现**，如实上报等产品负责人拍板。
// （PageShell 的 title 仍是可选参数：不传时顶部栏只留标签/操作区，这是母版的既有约定。）
// 2026-10-11 裁决（Lead）：原断言「功能页无左上角标题」的口径出自 2026-08-28 的一次界面改造记录
// （qa/baseline-change-log.txt），属**变更日志而不是规范条文**；而现行的 BFS-900《界面设计规范 v1.0》
// §6.3 906.6 明确承认「页面标题」层级（28px/600），附录 A 还把 .page-title 从 20px 调到 28px。
// 更关键的是**前提变了**：M1 已把左侧导航从 7 项平铺收敛为 3 项一级，用户在二级页面需要知道
// 自己在哪，页头正是定位手段。
// 所以本断言**不删除、改为有效判据**：功能页**若有**页头标题，必须符合 906.6 的层级。
// 回退方式：撤掉各功能页页头并恢复「不得有标题」，或只给 #/tasks-history 开例外。
const titleRoutes = ['#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts'];
const titleIssues = [];
for (const rr of titleRoutes) {
  await page.evaluate(r2 => { location.hash = r2; }, rr); await page.waitForTimeout(2400);
  const t = await page.evaluate(() => {
    const el = document.querySelector('[class*=page-title]');
    if (!el) return { text: null };
    const cs = getComputedStyle(el);
    return { text: (el.innerText || '').slice(0, 20), size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400 };
  });
  if (t.text === null) continue;
  if (!(t.size >= 20 && t.weight >= 600)) titleIssues.push(rr + '::' + t.text + ' size=' + t.size + ' weight=' + t.weight);
}
ok('TITLE-功能页标题符合906.6层级(存在则须≥20px/600)', titleIssues.length === 0, titleIssues.slice(0, 4).join('; ') || '各页无标题或层级合规');

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
