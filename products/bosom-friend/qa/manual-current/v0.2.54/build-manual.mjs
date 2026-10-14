/**
 * 图文使用手册生成器：把 Markdown 源渲染成自包含的单文件 HTML。
 *
 * 版式沿用上一版发布页（顶栏 + Hero + 目录侧栏 + 卡片章节 + 灯箱），差别两点：
 * 配图换成当前版本实机截图（转 JPEG 后内嵌，单文件可离线打开），
 * 以及新增「竖长图」样式（AI 助手面板这类窄高截图不套 8:5 画框）。
 *
 * 用法：node build-manual.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = resolve(HERE, '..', '..', '..')
const REPO = resolve(PRODUCT, '..', '..')
const SHOT_SRC = join(HERE, '..', 'capture-0.2.54')
const SHOT_DST = join(HERE, 'shots')
const OUT = join(HERE, '知音 · 图文使用手册.html')

/** 版本与日期只在这里改一处。 */
const VERSION = 'v0.2.54'
const UPDATED = '2026-09-18'

/** Markdown 里的图名 → 实机截图文件名（截图由 qa/manual-current/capture-0.2.54 抓取）。 */
const SHOTS = {
  '01-splash': '00-splash.png',
  '02-home': '01-home.png',
  '03-draftbox': '02-draftbox.png',
  '04-materials': '13-materials.png',
  '05-longvideo': '03-longvideo.png',
  '06-longvideo-storyboard': '26-longvideo-storyboard.png',
  '07-digital-humans': '04-digital-humans.png',
  '08-publish-dialog': '14-publish-dialog.png',
  '09-channel-modal': '15-channel-modal.png',
  '10-monitor': '09-monitor.png',
  '11-reception-rules': '17-reception-rules.png',
  '12-rule-modal': '19-rule-modal.png',
  '13-data': '08-data.png',
  '14-calendar': '07-calendar.png',
  '15-hot-topics': '05-ai-interaction.png',
  '16-comment-search': '20-comment-search.png',
  '17-tasks': '06-tasks.png',
  '18-task-detail': '21-task-detail.png',
  '19-knowledge': '11-knowledge.png',
  '20-ai-panel': '27-ai-panel.png',
  '21-settings-general': '12-settings.png',
  '22-settings-llm': '22-settings-llm.png',
  '23-settings-system': '23-settings-system.png',
  '24-settings-remote': '24-settings-remote.png',
}

const require = createRequire(import.meta.url)
const sharp = require(join(PRODUCT, 'project', 'bosom-friend-electron', 'node_modules', 'sharp'))

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 行内标记：先粗体、再代码、最后斜体（顺序反了 ** 会被斜体规则吃掉）。 */
function inline(text) {
  let out = escapeHtml(text)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
  return out
}

function slug(heading) {
  return heading
    .replace(/^(\d+)\.\s*/, '$1-')
    .replace(/[：:，,。、（）()／/·\s]/g, '')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
}

const md = readFileSync(join(HERE, '用户使用手册-图文版.md'), 'utf8')
const lines = md.split(/\r?\n/)

const chapters = []
const usedShots = []
let current = null
let i = 0
const isTable = (s) => s.startsWith('|')
const isUl = (s) => /^[-*] /.test(s)
const isOl = (s) => /^\d+\. /.test(s)
const isFigure = (s) => /^!\[[^\]]*\]\(shots\/[^)]+\.png\)$/.test(s)
const isQuote = (s) => s.startsWith('> ')

while (i < lines.length) {
  const line = lines[i].trim()

  if (line === '' || line === '---') { i++; continue }

  if (line.startsWith('## ')) {
    const title = line.slice(3).trim()
    current = { id: slug(title), num: chapters.length + 1, title, body: [] }
    chapters.push(current)
    i++
    continue
  }

  if (current === null) { i++; continue }   // 文档头部的 # 标题与 > 说明由页面外壳承担
  const body = current.body

  if (line.startsWith('### ')) {
    body.push('<h3>' + inline(line.slice(4).trim()) + '</h3>')
    i++
    continue
  }

  if (isFigure(line)) {
    const m = line.match(/^!\[([^\]]*)\]\(shots\/([^)]+)\.png\)$/)
    usedShots.push({ alt: m[1], name: m[2] })
    body.push('<!--SHOT:' + m[2] + '-->')
    i++
    continue
  }

  if (isQuote(line)) {
    const buf = []
    while (i < lines.length && isQuote(lines[i].trim())) { buf.push(lines[i].trim().slice(2)); i++ }
    body.push('<blockquote class="reveal"><p>' + inline(buf.join(' ')) + '</p></blockquote>')
    continue
  }

  if (isTable(line)) {
    const rows = []
    while (i < lines.length && isTable(lines[i].trim())) { rows.push(lines[i].trim()); i++ }
    const cells = rows.map(r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()))
    const html = ['<div class="tbl reveal"><table><tbody><tr>']
    html.push(cells[0].map(c => '<th>' + inline(c) + '</th>').join(''))
    html.push('</tr>')
    for (const row of cells.slice(2)) html.push('<tr>' + row.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>')
    html.push('</tbody></table></div>')
    body.push(html.join(''))
    continue
  }

  if (isUl(line)) {
    const items = []
    while (i < lines.length && isUl(lines[i].trim())) { items.push(lines[i].trim().slice(2)); i++ }
    body.push('<ul>' + items.map(t => '<li>' + inline(t) + '</li>').join('') + '</ul>')
    continue
  }

  if (isOl(line)) {
    const items = []
    while (i < lines.length && isOl(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d+\. /, '')); i++ }
    body.push('<ol>' + items.map(t => '<li>' + inline(t) + '</li>').join('') + '</ol>')
    continue
  }

  const buf = []
  while (i < lines.length) {
    const s = lines[i].trim()
    if (s === '' || s.startsWith('## ') || s.startsWith('### ') || isTable(s) || isUl(s) || isOl(s) || isQuote(s) || isFigure(s) || s === '---') break
    buf.push(s)
    i++
  }
  if (buf.length > 0) body.push('<p>' + inline(buf.join(' ')) + '</p>')
}

// 配图：转 JPEG 后内嵌，避免单文件里塞进几 MB 的 PNG。
const images = new Map()
for (const { name } of usedShots) {
  if (images.has(name)) continue
  const file = SHOTS[name]
  if (!file) throw new Error('未登记的配图：' + name)
  const src = join(SHOT_SRC, file)
  if (!existsSync(src)) throw new Error('缺截图：' + src)
  mkdirSync(SHOT_DST, { recursive: true })
  copyFileSync(src, join(SHOT_DST, name + '.png'))
  const meta = await sharp(src).metadata()
  const jpeg = await sharp(src).jpeg({ quality: 86, mozjpeg: true }).toBuffer()
  images.set(name, {
    uri: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
    tall: (meta.height || 0) > (meta.width || 0),
  })
}

const logoCandidates = [
  join(PRODUCT, 'project', 'bosom-friend-electron', 'public', 'logo.png'),
  join(REPO, 'products', 'bosom-friend', 'project', 'bosom-friend-electron', 'src', 'assets', 'logo.png'),
]
const logoPath = logoCandidates.find(p => existsSync(p))
const logoUri = logoPath ? 'data:image/png;base64,' + readFileSync(logoPath).toString('base64') : ''

const css = readFileSync(join(HERE, 'manual.css'), 'utf8')
  + '\n/* 竖长配图（AI 助手面板这类窄高截图）不套 8:5 画框，按原始比例限宽居中。 */\n'
  + 'p.fig-tall img{aspect-ratio:auto;max-width:300px;margin-left:auto;margin-right:auto}\n'

const sideLinks = chapters.map(c =>
  '<a href="#' + c.id + '"><span class="n">' + String(c.num).padStart(2, '0') + '</span>' + escapeHtml(c.title) + '</a>'
).join('')

const sections = chapters.map(c => {
  let body = c.body.join('\n')
  for (const [name, info] of images) {
    const figure = '<p' + (info.tall ? ' class="fig-tall"' : '') + '><img loading="lazy" src="' + info.uri + '" alt=""></p>'
    body = body.split('<!--SHOT:' + name + '-->').join(figure)
  }
  if (body.includes('<!--SHOT:')) throw new Error('有配图未被替换：' + c.title)
  return '<section class="card reveal" id="' + c.id + '"><div class="kicker"><i></i><span>CH.'
    + String(c.num).padStart(2, '0') + '</span></div><h2>' + inline(c.title) + '</h2>\n' + body
    + '\n</section>'
}).join('\n')

const lead = '<blockquote class="reveal"><p>适用版本：' + VERSION
  + ' 及以上（Windows 桌面端；界面由随包本地服务提供，本机浏览器打开同一地址即可看到同一套界面）。</p>'
  + '<p>配图说明：每张配图下方的表格按「从左到右、从上到下」的顺序说明各功能区域的位置与用途。</p>'
  + '<p>全部配图为 ' + VERSION + ' 实机界面截图。</p>'
  + '<p>产品名说明：安装包与界面里的产品名为 <strong>Bosom Friend</strong>，本手册标题沿用中文品牌「知音」。</p></blockquote>'

const html = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知音 · 图文使用手册</title><style>' + css + '</style></head>',
  '<body><div id="bar"></div><nav class="top"><a class="brand" href="#"><img class="blogo" src="' + logoUri + '" alt="">知音 · 使用手册</a><span class="ver"><span>' + VERSION + '+</span><span>' + UPDATED + '</span></span></nav>',
  '<header class="hero"><div class="eyebrow">ZHIYIN · OFFICIAL USER GUIDE</div><h1>知音 · AI 内容营销系统</h1><p class="sub">一句话创作 · 多平台发布 · 7×24 智能接待 —— 全流程图文指南</p><div class="chips"><span>Windows 桌面端</span><span>适用版本 ' + VERSION + '+</span><span>更新于 ' + UPDATED + '</span></div></header>',
  '<div class="layout"><nav class="side" id="side"><div class="tt">目 录</div>' + sideLinks + '</nav><main>' + lead,
  sections,
  '</main></div><button id="top" title="回到顶部">↑</button><div id="lb"><img id="lbi" alt=""></div>',
  '<script>var bar=document.getElementById(\'bar\'),btnTop=document.getElementById(\'top\');',
  'window.addEventListener(\'scroll\',function(){var h=document.documentElement;var p=h.scrollTop/(h.scrollHeight-h.clientHeight||1);bar.style.width=(p*100)+\'%\';if(h.scrollTop>520){btnTop.classList.add(\'show\');}else{btnTop.classList.remove(\'show\');}});',
  'btnTop.addEventListener(\'click\',function(){window.scrollTo({top:0,behavior:\'smooth\'});});',
  'var lb=document.getElementById(\'lb\'),lbi=document.getElementById(\'lbi\');',
  'document.querySelectorAll(\'main img\').forEach(function(im){im.addEventListener(\'click\',function(){lbi.src=im.src;lb.style.display=\'flex\';});});',
  'lb.addEventListener(\'click\',function(){lb.style.display=\'none\';});',
  'document.addEventListener(\'keydown\',function(e){if(e.key===\'Escape\'){lb.style.display=\'none\';}});',
  'try{',
  'var io=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){en.target.classList.add(\'in\');io.unobserve(en.target);}});},{threshold:.05});',
  'document.querySelectorAll(\'.reveal\').forEach(function(x){io.observe(x);});',
  'var spy=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){var ls=document.querySelectorAll(\'nav.side a\');ls.forEach(function(x){x.classList.remove(\'on\');});var l=document.querySelector(\'nav.side a[href="#\'+en.target.id+\'"]\');if(l){l.classList.add(\'on\');}}});},{rootMargin:\'-18% 0px -72% 0px\'});',
  'document.querySelectorAll(\'section.card\').forEach(function(s){spy.observe(s);});',
  '}catch(e){}</script><script>var _b=document.querySelector(\'a.brand\');if(_b){_b.addEventListener(\'click\',function(e){e.preventDefault();window.scrollTo({top:0,behavior:\'smooth\'});});}</script></body></html>',
].join('\n')

writeFileSync(OUT, html, 'utf8')
console.log('章节：' + chapters.length + '，配图：' + images.size + '，输出：' + OUT)
console.log('体积：' + (Buffer.byteLength(html) / 1024 / 1024).toFixed(2) + ' MB')
console.log('Logo：' + (logoPath || '未找到'))
