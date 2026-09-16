import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(4000);
const r = await page.request.post('http://127.0.0.1:3081/bosom-friend/api/ai/draft-generation/v2', {
  data: { quantity: 1, groupId: 'mg-persist', prompt: '测试长视频分镜', duration: 60, resolution: '1080p', aspectRatio: '16:9' }
});
const body = await r.json();
const id = body.data && body.data.taskIds && body.data.taskIds[0];
await page.waitForTimeout(2500);
const q = await page.request.post('http://127.0.0.1:3081/bosom-friend/api/ai/draft-generation/query', { data: { taskIds: [id] } });
const qb = await q.json();
const resp = qb.data && qb.data[0] && qb.data[0].response;
console.log('TASK first 900:', JSON.stringify(qb).slice(0, 900));
console.log('LONGVIDEO SEGMENTS:', resp && resp.longVideo ? resp.longVideo.segments.length : 'NONE');
await browser.close();