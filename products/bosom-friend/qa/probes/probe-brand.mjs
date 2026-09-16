import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(7000);
const info = await page.evaluate(() => {
  const out = [];
  const spans = [].slice.call(document.querySelectorAll('span,h1'));
  const bx = spans.filter(s => /Bosom/.test(s.textContent||'') && s.children.length < 3);
  for (const el of bx.slice(0, 10)) {
    const r = el.getBoundingClientRect();
    let anc = el; let bg = '';
    for (let i = 0; i < 5 && anc; i++) { const cs = getComputedStyle(anc); if (cs.backgroundImage !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)') { bg = 'L' + i + ':' + (cs.backgroundImage || cs.backgroundColor).slice(0, 80); break; } anc = anc.parentElement; }
    out.push(JSON.stringify({ tag: el.tagName, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), txt: (el.textContent||'').slice(0, 30), bg }));
  }
  return out;
});
console.log(info.join('\n'));
await browser.close();