// 黑盒边界专项：新端点、OPTIONS/CORS、404、异常体、静态资源 200 扫描。
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
function ok(name, cond, detail) { results.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); }
let st = await fetch(base + '/bosom-friend/api/v2/channels/accounts', { method: 'POST', headers: H, body: JSON.stringify({ type: 'douyin', uid: 'd-user-1', nickname: 'Test Acc' }) });
let acct = (await st.json()).data;
ok('account create', st.ok && !!acct.id, acct.id);
st = await fetch(base + '/bosom-friend/api/v2/channels/accounts/' + acct.id, { headers: H });
ok('account detail GET', st.ok, (await st.json()).code === 0 ? 'code0' : 'code!');
st = await fetch(base + '/bosom-friend/api/v2/channels/accounts/' + acct.id, { method: 'DELETE', headers: H });
ok('account delete', st.ok);
st = await fetch(base + '/bosom-friend/api/v2/channels/publish/flows', { method: 'POST', headers: H, body: JSON.stringify({ content: { title: 'T', body: 'B', media: [] }, publishAt: '', context: { type: 'ImageText' }, items: [{ accountId: 'a1', platform: 'xhs' }] }) });
const badFlow = await st.json();
ok('invalid flow rejected', st.ok && badFlow.code === 40000, badFlow.message);
st = await fetch(base + '/bosom-friend/api/v2/channels/publish/flows', { method: 'POST', headers: H, body: JSON.stringify({ content: { title: 'T', body: 'B', media: [{ url: '/bosom-friend/api/assets/file/x.png' }] }, publishAt: '', context: { type: 'ImageText' }, items: [{ accountId: 'a1', platform: 'xhs' }] }) });
const flow = (await st.json()).data;
st = await fetch(base + '/bosom-friend/api/v2/channels/publish/records/' + flow.tasks[0].id, { headers: H });
const recBody = await st.json();
ok('record detail GET', st.ok && recBody.code === 0 && recBody.data.id === flow.tasks[0].id, recBody.data.title);
await fetch(base + '/bosom-friend/api/v2/channels/publish/records/' + flow.tasks[0].id, { method: 'DELETE', headers: H, body: '{}' });
st = await fetch(base + '/bosom-friend/api/ai/video/generations?page=1&pageSize=5', { headers: H });
ok('video generations', st.ok, (await st.json()).code === 0 ? 'code0' : 'code!');
st = await fetch(base + '/bosom-friend/api/user/mine', { method: 'OPTIONS' });
const allow = st.headers.get('access-control-allow-methods');
ok('OPTIONS preflight', st.status === 204 && allow && allow.includes('POST'), 'status=' + st.status + ' allow=' + allow);
st = await fetch(base + '/bosom-friend/api/definitely/not/a/route', { headers: H });
const nf = await st.json();
ok('404 envelope', st.status === 200 && nf.code === 40400, 'code=' + nf.code);
st = await fetch(base + '/bosom-friend/api/login/mail', { method: 'POST', headers: H, body: '{broken' });
const bj = await st.json();
ok('invalid json envelope', st.status === 200 && bj.code === 40000, 'code=' + bj.code);
st = await fetch(base + '/bosom-friend/api/assets/uploadSign', { method: 'POST', headers: H, body: JSON.stringify({ filename: 't.png', size: 10, type: 'userFile' }) });
const up = (await st.json()).data;
ok('uploadSign', !!up.id && !!up.uploadUrl, up.uploadUrl);
st = await fetch(base + up.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from([137, 80, 78, 71]) });
ok('upload PUT', st.status === 200);
st = await fetch(base + '/bosom-friend/api/assets/' + up.id + '/confirm', { method: 'POST', headers: H, body: JSON.stringify({ id: up.id }) });
const conf = (await st.json()).data;
ok('upload confirm', st.ok && !!conf.url, conf.url);
st = await fetch(base + conf.url);
ok('file GET', st.status === 200 && (st.headers.get('content-type') || '').includes('image/png'), st.headers.get('content-type'));
const html = await (await fetch(base + '/bosom-friend/')).text();
const refs = [...html.matchAll(/(?:src|href)=\"([^\"]+)\"/g)].map(m => m[1]).filter(u => u.includes('/assets/') || u.endsWith('.ico'));
let assetsOk = 0;
for (const ref of refs) {
  const url = ref.startsWith('http') ? ref : base + '/bosom-friend/' + ref.replace(/^\.\//, '');
  const res = await fetch(url);
  if (res.status === 200) assetsOk++;
}
ok('static assets', assetsOk === refs.length, assetsOk + '/' + refs.length);
console.log(results.join(String.fromCharCode(10)));
