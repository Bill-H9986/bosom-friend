// 拆分后全路由回归：导航/渲染/错误全量检查。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 160)));
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(9000);
const routes = ['#/accounts', '#/monitor', '#/data-statistics', '#/calendar', '#/draft-box', '#/ai-interaction', '#/tasks-history', '#/knowledge', '#/settings'];
for (const r of routes) {
  await page.evaluate((rr) => { location.hash = rr; }, r);
  await page.waitForTimeout(4500);
  const len = await page.evaluate(() => document.body.innerText.length);
  console.log('route ' + r + ' bodyLen=' + len);
}
// 账号页入口卡片断言
await page.evaluate(() => { location.hash = '#/accounts'; });
await page.waitForTimeout(4000);
const cardText = await page.evaluate(() => document.body.innerText.includes('数据中心') && document.body.innerText.includes('发布日历') && document.body.innerText.includes('全局监控'));
console.log('entryCardsShown=' + cardText);
console.log('pageerrors=' + errors.length);
for (const e of errors.slice(0, 6)) console.log('  PE: ' + e.split(String.fromCharCode(10))[0]);
await browser.close();