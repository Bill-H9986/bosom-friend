import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(6000);
await page.addScriptTag({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/axe-core.min.js' });
const info = await page.evaluate(async () => {
  const s2 = document.createElement('div');
  s2.id = '__poison_txt__';
  s2.textContent = '毒丸文本对比度测试';
  s2.style.cssText = 'color:#fefefe;background-color:#ffffff;font-size:12px;display:block;position:fixed;left:0px;top:0px;width:200px;height:24px;z-index:2147483647';
  document.body.appendChild(s2);
  await new Promise(r => setTimeout(r, 500));
  const cs = getComputedStyle(s2);
  const v = await window.axe.run(s2, { runOnly: { type: 'rule', values: ['color-contrast'] } });
  return {
    inDom: s2.isConnected, parent: s2.parentElement ? s2.parentElement.tagName : 'none',
    color: cs.color, bg: cs.backgroundColor, disp: cs.display, pos: cs.position, z: cs.zIndex,
    rect: JSON.stringify(s2.getBoundingClientRect()),
    viol: v.violations.map(x => x.id + 'x' + x.nodes.length),
    incomp: v.incomplete.map(x => x.id + 'x' + x.nodes.length),
    pass: v.passes.map(x => x.id + 'x' + x.nodes.length)
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();