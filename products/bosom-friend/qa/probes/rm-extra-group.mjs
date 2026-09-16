const base = 'http://127.0.0.1:3081';
const H = { Authorization: 'Bearer x', 'content-type': 'application/json' };
const list = await (await fetch(base + '/bosom-friend/api/material/group/list/1/10', { headers: H })).json();
console.log('before: ' + JSON.stringify(list.data.list.map(g => g.name)));
for (const g of list.data.list) {
  if (g.name === '默认草稿箱' || g.name === 'demo') {
    const del = await (await fetch(base + '/bosom-friend/api/material/group/' + g.id, { method: 'DELETE', headers: H })).json();
    console.log('deleted ' + g.name + ' -> ' + del.code);
  }
}
const after = await (await fetch(base + '/bosom-friend/api/material/group/list/1/10', { headers: H })).json();
console.log('after: ' + JSON.stringify(after.data.list.map(g => g.name)));