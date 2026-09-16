import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(4000);
// 直接 POST 60 秒长视频草稿生成
const r = await page.request.post('http://127.0.0.1:3081/bosom-friend/api/ai/draft-generation/v2', {
  data: { quantity: 1, groupId: 'mg-persist', prompt: '测试长视频分镜', duration: 60, resolution: '1080p', aspectRatio: '16:9' }
});
const body = await r.json();
console.log('GENERATE:', JSON.stringify(body));
await page.waitForTimeout(2500);
// 查询任务结果
const id = body.data && body.data.taskIds && body.data.taskIds[0];
if (id) {
  const q = await page.request.get('http://127.0.0.1:3081/bosom-friend/api/ai/draft-generation/query?taskIds=' + encodeURIComponent(JSON.stringify([id])));
  const qb = await q.json();
  console.log('TASK:', JSON.stringify(qb).slice(0, 1400));
  const resp = qb.data && qb.data[0] && qb.data[0].response;
  console.log('LONGVIDEO SEGMENTS:', resp && resp.longVideo ? resp.longVideo.segments.length : 'NONE');
}
await browser.close();