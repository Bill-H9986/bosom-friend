import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/calendar', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(6000);
await page.addScriptTag({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/axe-core.min.js' });
const info = await page.evaluate(async () => {
  const r = await window.axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] } });
  return r.violations.flatMap(v => v.nodes.map(n => {
    const el = n.target.length ? document.querySelector(n.target.join(' ')) : null;
    if (!el) return 'MISS ' + n.target.join(' ');
    const cs = getComputedStyle(el);
    return n.target[0] + ' | color=' + cs.color + ' bg=' + cs.backgroundColor + ' font=' + cs.fontSize + ' | txt=' + (el.textContent||'').trim().slice(0,30) + ' | html=' + el.outerHTML.slice(0, 220);
  }));
});
console.log(info.join('\n\n'));
await browser.close();