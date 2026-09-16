import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
await page.addScriptTag({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/axe-core.min.js' });
const dump = {};
for (const rr of ['#/ai-interaction', '#/knowledge', '#/data-statistics', '#/monitor']) {
  await page.evaluate(r2 => { location.hash = r2; }, rr); await page.waitForTimeout(3500);
  const v = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }); return r.violations.map(x => ({ id: x.id, impact: x.impact, nodes: x.nodes.map(n => ({ target: n.target.join(' '), html: n.html.slice(0, 120) })).slice(0, 12) })); });
  dump[rr] = v;
}
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/a11y-detail2.json', JSON.stringify(dump, null, 1));
console.log(JSON.stringify(dump, null, 1).slice(0, 6500));
await browser.close();