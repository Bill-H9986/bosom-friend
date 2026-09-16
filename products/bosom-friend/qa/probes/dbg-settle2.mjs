const base = 'http://127.0.0.1:3081';
const H = { Authorization: 'Bearer x', 'content-type': 'application/json' };
const c = await (await fetch(base + '/bosom-friend/api/ai/draft-generation/v2', { method: 'POST', headers: H, body: JSON.stringify({ quantity: 2, groupId: 'g', model: 'm', prompt: '测试' }) })).json();
console.log('created ' + c.data.taskIds.join(','));
await new Promise(r => setTimeout(r, 6000));
const q = await (await fetch(base + '/bosom-friend/api/ai/draft-generation/query', { method: 'POST', headers: H, body: JSON.stringify({ taskIds: c.data.taskIds }) })).json();
console.log('status=', q.data.map(t => t.status).join(','));