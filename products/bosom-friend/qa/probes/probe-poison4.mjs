import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(6000);
await page.addScriptTag({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/axe-core.min.js' });
const info = await page.evaluate(async () => {
  const out = {};
  const r = await window.axe.run(document);
  out.viol = r.violations.map(x => x.id + 'x' + x.nodes.length);
  out.incomp = r.incomplete.map(x => x.id + 'x' + x.nodes.length);
  // 再测一个我们知道基本必报的对比度元素：悬停遮罩外面的 icon 文本
  const s2 = document.createElement('div');
  s2.textContent = '低对比测试ABC';
  s2.style.cssText = 'color:#aaa;background:#fff;font-size:12px;display:inline-block;width:120px;height:20px;position:relative';
  document.body.appendChild(s2);
  await new Promise(res => setTimeout(res, 400));
  const r2 = await window.axe.run(s2, { runOnly: { type: 'rule', values: ['color-contrast'] } });
  out.v2 = r2.violations.map(x => x.id + 'x' + x.nodes.length + ':' + (x.nodes[0] && x.nodes[0].failureSummary || '').slice(0, 100));
  out.i2 = r2.incomplete.map(x => x.id + 'x' + x.nodes.length);
  s2.remove();
  return out;
});
console.log(JSON.stringify(info, null, 1));
await browser.close();