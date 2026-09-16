// probe-redeem.mjs - 规范 JSON 兑换验证
const H = { Authorization: 'Bearer x', 'Content-Type': 'application/json' }
const c0 = await (await fetch('http://127.0.0.1:3081/bosom-friend/api/user/credits', { headers: H })).json()
console.log('before balance=', c0.data.balance)
const rd = await (await fetch('http://127.0.0.1:3081/bosom-friend/api/user/credits/redeem', { method: 'POST', headers: H, body: JSON.stringify({ code: 'BF-TEST-EXPERIENCE' }) })).json()
console.log('redeem code=', rd.code, 'balance=', rd.data?.balance, 'msg=', rd.message)
const c1 = await (await fetch('http://127.0.0.1:3081/bosom-friend/api/user/credits', { headers: H })).json()
console.log('after balance=', c1.data.balance)
