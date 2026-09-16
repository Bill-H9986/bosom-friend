import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(8000);
await page.evaluate(() => { const cb = [...document.querySelectorAll('[role=dialog] button, [role=dialog] span')].find(x => /我已阅读并同意/.test((x.innerText || ''))); if (cb) cb.click(); }); await page.waitForTimeout(400);
await page.evaluate(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /同意并进入平台/.test(x.innerText || '')); if (b && !b.disabled) b.click(); }); await page.waitForTimeout(1200);
await page.addScriptTag({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/axe-core.min.js' });
const dump = {};
for (const rr of ['#/calendar', '#/draft-box', '#/tasks-history', '#/settings', '#/accounts']) {
  await page.evaluate(r2 => { location.hash = r2; }, rr); await page.waitForTimeout(3000);
  const v = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }); return r.violations.map(x => ({ id: x.id, impact: x.impact, nodes: x.nodes.map(n => ({ target: n.target.join(' '), html: n.html.slice(0, 130) })).slice(0, 6) })); });
  dump[rr] = v;
}
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/a11y-detail.json', JSON.stringify(dump, null, 1));
console.log(JSON.stringify(dump, null, 1).slice(0, 5500));
await browser.close();