const base = 'http://127.0.0.1:3081';
const H = { Authorization: 'Bearer x', 'content-type': 'application/json' };
const list = await (await fetch(base + '/bosom-friend/api/material/group/list/1/20', { headers: H })).json();
for (const g of list.data.list) {
  if (g.name !== '持久化素材组') {
    const del = await (await fetch(base + '/bosom-friend/api/material/group/' + g.id, { method: 'DELETE', headers: H })).json();
    console.log('deleted ' + g.name + ' -> ' + del.code);
  }
}
const after = await (await fetch(base + '/bosom-friend/api/material/group/list/1/20', { headers: H })).json();
console.log('FINAL groups: ' + JSON.stringify(after.data.list.map(g => g.name)));