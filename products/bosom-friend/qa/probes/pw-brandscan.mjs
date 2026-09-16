import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /同意并进入平台/.test(x.innerText || '')); if (b) b.click(); });
await page.waitForTimeout(1200);
const pages = ['#/', '#/draft-box', '#/tasks-history', '#/ai-interaction', '#/knowledge', '#/calendar', '#/data-statistics', '#/monitor', '#/settings', '#/accounts'];
const dump = {};
for (const r of pages) {
  await page.evaluate(rr => { location.hash = rr; }, r);
  await page.waitForTimeout(3800);
  dump[r] = await page.evaluate(() => document.body.innerText);
}
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/site-text.json', JSON.stringify(dump, null, 1));
const all = Object.values(dump).join('\n');
const bad = ['知音', 'zhiyin', 'aitoearn', '8080', 'zhìyīn'].filter(w => all.toLowerCase().includes(w.toLowerCase()));
console.log('badWordHits=' + JSON.stringify(bad));
const eng = [...new Set(all.match(/[A-Za-z]{3,}/g) || [])].filter(w => !['Bosom','Friend','AI','OSS','FAQ','MCP','APP','H5','API','ID','WEB','Email','PC','URL','FAQ','OK','JSON','OK'].includes(w));
console.log('englishWords=' + JSON.stringify(eng.slice(0, 40)));
console.log('totalText=' + all.length);
await browser.close();