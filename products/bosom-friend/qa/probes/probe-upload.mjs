import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/#/draft-box', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
const info = await page.evaluate(() => {
  const out = [];
  // 输入框区域描述
  const editor = document.querySelector('[data-testid=draftbox-ai-prompt-input]');
  out.push('EDITOR: ' + (editor ? 'present w=' + Math.round(editor.getBoundingClientRect().width) + ' h=' + Math.round(editor.getBoundingClientRect().height) : 'MISSING'));
  // 上传按钮/素材区域关键词
  const cands = [].slice.call(document.querySelectorAll('button, [role=button], [class*=upload], [class*=Upload], label'));
  const up = cands.filter(el => /upload|上传|素材|素材库/i.test((el.textContent||'') + ' ' + (el.className||'').toString() + ' ' + (el.getAttribute('aria-label')||''))).slice(0, 15);
  out.push('UPLOAD MATCHES: ' + up.length);
  for (const el of up.slice(0, 10)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.push('  - ' + el.tagName + ' cls=' + (el.className||'').toString().slice(0,70) + ' rect=' + [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)].join(',') + ' visible=' + (cs.display!=='none' && parseFloat(cs.opacity)>0 && r.width>0));
  }
  // 文字是否含'上传'
  const texts = [].slice.call(document.querySelectorAll('span,div,p,button')).filter(el => /上传/.test((el.textContent||'').trim()) && (el.textContent||'').trim().length < 40).slice(0, 12);
  for (const el of texts) {
    const r = el.getBoundingClientRect();
    out.push('TXT「' + (el.textContent||'').trim().slice(0,30) + '」@' + [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)].join(',') + ' vis=' + (r.width>0));
  }
  return out.join('\n');
});
console.log(info);
await browser.close();