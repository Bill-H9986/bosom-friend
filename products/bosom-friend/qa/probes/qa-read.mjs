const base = 'http://127.0.0.1:3081';
const H = { Authorization: 'Bearer x' };
const t = await (await fetch(base + '/bosom-friend/api/agent/tasks', { headers: H })).json();
console.log('after restart tasks=' + t.data.total + ' first=' + (t.data.list[0] && t.data.list[0].title));