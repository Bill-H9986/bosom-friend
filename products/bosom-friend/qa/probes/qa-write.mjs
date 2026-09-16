const base = 'http://127.0.0.1:3081';
const H = { Authorization: 'Bearer x', 'content-type': 'application/json' };
const t = await (await fetch(base + '/bosom-friend/api/agent/tasks', { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'QA持久化验证' }) })).json();
console.log('write task=' + t.data.id);