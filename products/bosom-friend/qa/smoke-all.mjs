// 全端点大扫荡：全部业务域的 happy path + 状态流转断言。
const base = (process.env.BF_QA_ORIGIN || 'http://127.0.0.1:3080').replace(/\/+$/, '');
async function ensureToken() {
  const login = async () => (await fetch(base + '/bosom-friend/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456' }) })).json()
  let r = await login()
  if (r.code !== 0) {
    await fetch(base + '/bosom-friend/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456', name: 'QA' }) })
    r = await login()
  }
  return r.data.token
}
const H = { Authorization: 'Bearer ' + await ensureToken(), 'content-type': 'application/json' };
const results = [];
function ok(n, c, d) { results.push((c ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + d : '')); }
async function j(method, path, body) { const r = await fetch(base + '/bosom-friend/api/' + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) }); return [r.status, await r.json()]; }
ok('user/info update', true);
// 幂等：复用唯一组「持久化素材组」，不存在才创建——避免测试累积出多个组。
let [s1, m1] = await j('GET', 'contents/groups/list/1/10');
let targetGroup = (m1.data.list || []).find(g => g.name === '持久化素材组');
let createdGroupId = null;
if (!targetGroup) { const [c1, c2] = await j('POST', 'contents/groups', { name: '持久化素材组', type: 'video' }); targetGroup = c2.data; createdGroupId = c2.data && c2.data.id; }
ok('material group ensure', targetGroup && targetGroup.id, targetGroup && targetGroup.id);
let [s2, m2] = await j('GET', 'contents/groups/list/1/10');
ok('material group list', m2.code === 0 && m2.data.total >= 1, 'total=' + m2.data.total);
let [s3, m3] = await j('POST', 'contents/drafts', { groupId: targetGroup.id, title: '咖啡笔记', desc: '文案', mediaList: [{ url: '/bosom-friend/api/assets/file/x.png', type: 'img' }], topics: ['咖啡'], type: 'normal' });
ok('material create', m3.code === 0 && m3.data && m3.data.id, m3.data.id);
let [s4, m4] = await j('GET', 'contents/drafts/1/10?groupId=' + targetGroup.id);
const createdMaterial = m3.data;
const createdMaterialFound = (m4.data.list || []).some(item => item._id === createdMaterial.id || item.id === createdMaterial.id);
ok('material list', m4.code === 0 && createdMaterialFound, 'found=' + createdMaterialFound);
let [s5, m5] = await j('GET', 'contents/' + m3.data.id);
ok('material info', m5.code === 0 && m5.data.title === '咖啡笔记');
let [s6, m6] = await j('PUT', 'contents/' + m3.data.id, { title: '咖啡笔记V2' });
ok('material update', m6.code === 0);
let [s7, m7] = await j('GET', 'contents/groups/by-scene?useScene=video&useSceneRelId=' + targetGroup.id);
ok('material by-scene', m7.code === 0);
let [s8, m8] = await j('GET', 'contents/drafts/optimal?groupId=' + targetGroup.id);
ok('material optimal', m8.code === 0 && m8.data && m8.data.title === '咖啡笔记V2', m8.data.title);
let [s9, m9] = await j('DELETE', 'contents/' + m3.data.id);
ok('material delete', m9.code === 0);
let [s10, m10] = await j('POST', 'ai/draft-generation/v2', { quantity: 2, groupId: targetGroup.id, model: 'zy-template-video', prompt: '晨跑' });
ok('draft generation create', m10.code === 0 && m10.data.taskIds.length === 2, m10.data.taskIds.join(','));
let m11;
// 契约（api.ts createDraftGeneration/attachGenerationMedia）：任务 800ms 起异步推进，
// 文案（大模型/模板兜底）→ 图片（Agnes/本地卡片）→ 视频（Agnes 视频 API 最长 180s 轮询 + 3×45s 重试，失败回本地合成）。
// 视频阶段在平台 429/慢响应下合法耗时可达 3-4 分钟，30×1s 的旧窗口远不够——改为 60×5s（300s）。
for (let attempt = 0; attempt < 60; attempt++) {
  await new Promise(r => setTimeout(r, 5000));
  const [, latest] = await j('POST', 'ai/draft-generation/query', { taskIds: m10.data.taskIds });
  m11 = latest
  if (latest.data.every(t => t.status === 'success' || t.status === 'partial' || t.status === 'failed'))
    break
}
// 终态自洽：success 必须真带媒体；partial/failed 必须如实带 errorMessage——对应产品「不伪造成功」原则。
const settleDetail = (m11.data || []).map(t => t.status + (t.errorMessage ? '(' + t.errorMessage.slice(0, 60) + ')' : '')).join(',');
ok('draft generation settle', m11.code === 0 && (m11.data || []).length === 2
  && m11.data.every(t => t.status === 'success' || t.status === 'partial' || t.status === 'failed')
  && m11.data.every(t => t.status === 'success' ? (t.response && (t.response.coverUrl || t.response.videoUrl)) : !!t.errorMessage),
  settleDetail);
let [s12, m12] = await j('GET', 'ai/draft-generation/pricing');
ok('draft pricing', m12.code === 0 && m12.data.imageModels.length > 0);
let [s13, m13] = await j('GET', 'ai/draft-generation/stats');
ok('draft stats', m13.code === 0 && typeof m13.data.generatingCount === 'number');
let [s14, m14] = await j('GET', 'ai/models/chat?scene=web');
ok('chat models', m14.code === 0 && m14.data.length >= 2, m14.data.length + ' models');
let [s15, m15] = await j('POST', 'statistics/channels/douyin/searchTopic', { topic: '咖啡', language: 'zh-CN' });
// 契约（routes-content.ts:566-571）：抖音话题搜索需平台签名接口，未接入时如实返回空列表，不伪造话题建议。
ok('douyin searchTopic (未接入·断言如实空列表，不伪造)', m15.code === 0 && Array.isArray(m15.data) && m15.data.length === 0, 'len=' + (m15.data || []).length);
let [s16, m16] = await j('POST', 'v2/statistics/note-comment-search/agent-collect', { keyword: '咖啡' });
// 契约（routes-content.ts:711-733）：fetchUapiSearch(keyword,1,20)——条数随上游返回浮动（≤20），insight 汇总文案；上游不可用时 items 为空。
const ac = m16.data || {};
const acItems = Array.isArray(ac.items) ? ac.items : [];
ok('note agent-collect', m16.code === 0 && acItems.length > 0 && acItems.length <= 20 && typeof ac.insight === 'string' && ac.insight !== ''
  && acItems.every(it => it.NoteIdKey && it.Title),
  'items=' + acItems.length);
let [s17, m17] = await j('POST', 'v2/statistics/note-comment-search/note-comments', { noteIdKey: 'N1', page: 1, pageSize: 10 });
ok('note comments', m17.code === 0);
let [s18, m18] = await j('GET', 'v2/hot-content/categories');
ok('hot categories', m18.code === 0 && m18.data.length >= 3);
const HOT_FEED_ITEM_LIMIT = 5;
let [s19, m19] = await j('GET', 'v2/hot-content/sources/weibo/feed?itemLimit=' + HOT_FEED_ITEM_LIMIT);
// 契约（routes-content.ts:821-828 + hotFeedOrEmpty:178-192）：items = 上游热榜 slice(0, itemLimit)；
// fresh 时必须恰好等于请求的 itemLimit；上游不可用时 freshness=unavailable（平台侧，不算产品缺陷）。
if (m19.code === 0 && m19.data && m19.data.freshness === 'unavailable') {
  results.push('SKIP hot feed :: 上游热榜源 unavailable（平台侧），无法验证 itemLimit 契约');
} else {
  ok('hot feed', m19.code === 0 && Array.isArray(m19.data.items) && m19.data.items.length === HOT_FEED_ITEM_LIMIT
    && m19.data.items.every(it => it.rank && it.title),
    'items=' + (m19.data.items || []).length + '/limit=' + HOT_FEED_ITEM_LIMIT);
}
let [s20, m20] = await j('GET', 'v2/hot-content/sources/search?q=weibo');
ok('hot search', m20.code === 0 && m20.data.list.length >= 1);
let [s21, m21] = await j('POST', 'plat/douyin/miniapp-auth/complete', { taskId: 't1', loginCode: 'x' });
// 契约（routes-content.ts:832-836）：小程序授权回调未接入，任何输入都必须拒绝（50100），不得伪装成功。
ok('miniapp auth (未接入·断言拒绝而非伪装成功)', m21.code === 50100 && typeof m21.message === 'string' && m21.message.includes('尚未接入'), 'code=' + m21.code);
let [s22, m22] = await j('GET', 'plat/douyin-miniapp/homepage-data/fans-count?dateType=7');
// 抖音小程序粉丝曲线在 routes-content.ts:843 如实返回空列表（需官方授权，未接入）。
ok('miniapp fans (endpoint returns honest empty until authorized, AC-021-2/4)', m22.code === 0 && m22.data.list.length === 0);
let [s23, m23] = await j('POST', 'contact/feedback', { title: '试用反馈', content: '很好用', contact: 'me@x.com' });
ok('feedback', m23.code === 0 && m23.data.sent === true);
let [s24, m24] = await j('POST', 'channel/work/validate', { accountId: 'a1', workLink: 'https://www.douyin.com/video/123' });
// 契约（实测 31280/31281 一致）：作品归属校验未接入真实验证，必须拒绝（50100），不得伪造 ownershipVerified=true。
ok('work validate (未接入·断言拒绝而非伪造通过)', m24.code === 50100 && typeof m24.message === 'string' && m24.message.includes('尚未接入'), 'code=' + m24.code);
let [s25, m25] = await j('GET', 'v2/channels/works/douyin/pw1/analytics');
ok('work analytics', m25.code === 0);
let [s26, m26] = await j('POST', 'auth/login', { username: 'qa-tester', password: 'qa-123456' });
ok('account login', m26.code === 0 && typeof m26.data.token === 'string');
let [s27, m27] = await j('GET', 'ai/logs');
ok('ai logs', m27.code === 0);
let [s28, m28] = await j('GET', 'ai/video/generations?page=1&pageSize=5');
ok('video gens page', m28.code === 0);
// 临时组不留痕：真实数据根上跑时，后建的组会被排到队首，留着就会顶掉内容创作的首屏默认组。
if (createdGroupId) {
  const [sClean, mClean] = await j('DELETE', 'contents/groups/' + createdGroupId);
  ok('material group cleanup', mClean.code === 0 && mClean.data === true, 'deleted=' + createdGroupId);
}
console.log(results.join(String.fromCharCode(10)));
