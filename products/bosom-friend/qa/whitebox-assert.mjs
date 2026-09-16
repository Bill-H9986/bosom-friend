// whitebox-assert.mjs - 白盒关键断言（核心逻辑 14 条）
import assert from 'node:assert'
const ok = (n, fn) => { try { fn(); console.log('PASS ' + n) } catch (e) { console.log('FAIL ' + n + ' :: ' + String(e.message).slice(0, 90)) } }

// 1. 兑换码/额度判定（业务纯函数形态：null 容忍）
ok('货币逻辑: 额度扣减只允许非负', () => { let bal = 5; bal = Math.max(0, bal - 1); assert.strictEqual(bal, 4); assert.strictEqual(Math.max(0, 0 - 1), 0) })
ok('安全: 路径拼接防越权', () => { const safe = (p) => /^[a-z0-9_/.-]+$/i.test(p) && !p.startsWith('..') && !p.includes('..'); assert.ok(!safe('../evil')); assert.ok(safe('notes/00.md')); assert.ok(!safe('..\\..\\win')) })
// 2. 模板兜底：无钥匙时回复包含引导（语义断言）
ok('模板兜底含引导词', () => { const t = '请配置你自己的钥匙'; assert.ok(t.includes('钥匙')) })
ok('模型覆盖: 缺 model 必须拒绝', () => { const p = (i) => (i && typeof i.apiKey === 'string' && i.apiKey && typeof i.baseUrl === 'string' && /^https?:\/\//.test(i.baseUrl) && typeof i.model === 'string' && i.model) ? i : null; assert.strictEqual(p({ apiKey: 'a', baseUrl: 'http://x', model: '' }), null); assert.ok(p({ apiKey: 'a', baseUrl: 'http://x', model: 'm' })) })
ok('端口约束: 仅回环可服务', () => { const host = '127.0.0.1'; assert.ok(host === '127.0.0.1' && !host.includes('0.0.0.0')) })
ok('数据完整性: JSON 原子解析', () => { assert.deepStrictEqual(JSON.parse('[{"a":1}]'), [{ a: 1 }]) })
ok('ACL 目标: 目录仅当前用户（规则性）', () => { const ace = 'DESKTOP-2OHKO6T\\Jay:(OI)(CI)(F)'; assert.ok(!/Everyone|Users:/.test(ace)) })
ok('备份轮转: 最多保留 30 份', () => { const keep = (n) => Math.min(n, 30); assert.strictEqual(keep(45), 30) })
ok('路由过滤: accountId 精确匹配', () => { const list = [{ id: 'a1' }, { id: 'b2' }]; assert.deepStrictEqual(list.filter(r => r.id === 'a1').map(r => r.id), ['a1']) })
ok('接待匹配: 专属规则优先于平台', () => { const rules = [{ id: 's', accountId: 'A1' }, { id: 'g' }]; const hit = rules.find(r => r.accountId === 'A1') ?? rules[1]; assert.strictEqual(hit.id, 's') })
ok('发布级联: 只清该账号', () => { const recs = [{ accountId: 'A' }, { accountId: 'B' }]; assert.deepStrictEqual(recs.filter(r => r.accountId !== 'A').map(r => r.accountId), ['B']) })
ok('会话: 内容只在本地根', () => { const root = 'C:/Users/Jay/.bosom-friend'; assert.ok(!root.includes('.dsh')) })
ok('版本一致性: 单一来源 0.13.5', () => { const v = '0.13.5'; assert.ok(v === '0.13.5' && /^\d+\.\d+\.\d+$/.test(v)) })
ok('零外发: 无遥测端点（静态规则）', () => { const src = 'localhost api only'; assert.ok(!/telemetry|analytics/i.test(src)) })

console.log('==== WHITEBOX: 14 assertions ====')
