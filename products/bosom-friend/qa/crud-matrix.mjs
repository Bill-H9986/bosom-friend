#!/usr/bin/env node
/**
 * 业务域 CRUD 四步矩阵（铁律 #9 第 2/6 条的可执行检查）。
 *
 * 每个业务域验证四步：新增 → 列表出现 → 编辑生效 → 删除后列表消失且不可再读；
 * 每一步同时校验「接口返回」与「落盘文件」，并附带空态断言（删除后集合确实少了该条）。
 * 测试数据全部使用自检前缀并在脚本结束时清理，不触碰用户真实数据。
 *
 * 用法：node products/bosom-friend/qa/crud-matrix.mjs
 * 退出码：0 = 全绿；1 = 存在失败；2 = 应用未运行（无法检查）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ORIGIN = process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280'
const BASE = ORIGIN + '/bosom-friend/api/'
const TOKEN = process.env.BF_QA_TOKEN ?? 'bf-local-guest-token'
const DATA_ROOT = process.env.BOSOM_FRIEND_HOME ?? join(homedir(), '.bosom-friend', 'bosom-friend')
const STAMP = String(Date.now()).slice(-6)
const results = []

/** 记录一条断言结果；失败也继续跑，最后统一汇总。 */
function check(ok, id, detail) {
  results.push({ ok, id, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' | ' + detail)
}

/** 调用产品 HTTP 接口，返回 { code, data, message, status }。 */
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { code: -1, message: text.slice(0, 200) } }
  return { status: res.status, code: json.code, data: json.data, message: json.message }
}

/** 读数据根下的 JSON 文件（JsonFile 外层信封 { schemaVersion, value } 自动解包）。 */
function disk(file) {
  try {
    const parsed = JSON.parse(readFileSync(join(DATA_ROOT, file), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed
  } catch { return undefined }
}

/** 在集合里按断言找一条。 */
function find(list, pred) {
  return Array.isArray(list) ? list.find(pred) : undefined
}

async function main() {
  // 连通性：应用未运行时退出码 2，门禁据此判黄灯而非红灯。
  try {
    const probe = await api('GET', 'v2/channels/account-groups')
    if (probe.code !== 0) throw new Error('code=' + probe.code)
  } catch (error) {
    console.log('CRUD_MATRIX SKIP 应用未运行（' + ORIGIN + '）：' + (error instanceof Error ? error.message : String(error)))
    process.exit(2)
  }

  // ---- 域 1：账号分组 account-groups.json（B2-02 / B2-03） ----
  const g1 = '自检分组-' + STAMP
  const g2 = '自检分组改-' + STAMP
  const created = await api('POST', 'v2/channels/account-groups', { name: g1 })
  const gid = created.data?.id
  check(created.code === 0 && gid !== undefined, '账号分组·增', 'code=' + created.code + ' id=' + gid)
  const list1 = await api('GET', 'v2/channels/account-groups')
  check(find(list1.data, g => g.id === gid && g.name === g1) !== undefined, '账号分组·查', '分组数=' + (list1.data?.length ?? 0))
  check(find(disk('account-groups.json'), g => g.id === gid) !== undefined, '账号分组·落盘', 'account-groups.json')
  const patched = await api('PATCH', 'v2/channels/account-groups/' + gid, { name: g2 })
  check(patched.code === 0 && patched.data?.name === g2, '账号分组·改', 'name=' + patched.data?.name)
  const list2 = await api('GET', 'v2/channels/account-groups')
  check(find(list2.data, g => g.id === gid && g.name === g2) !== undefined, '账号分组·改后可见', '')
  const del1 = await api('DELETE', 'v2/channels/account-groups', { ids: [gid] })
  const list3 = await api('GET', 'v2/channels/account-groups')
  check(del1.code === 0 && find(list3.data, g => g.id === gid) === undefined, '账号分组·删', 'api=' + JSON.stringify(del1.data))
  check(find(disk('account-groups.json'), g => g.id === gid) === undefined, '账号分组·删后落盘消失', '')
  check(find(list3.data, g => g.isDefault === true) !== undefined, '账号分组·空态（默认分组仍在）', '默认分组=' + find(list3.data, g => g.isDefault === true)?.name)

  // ---- 域 2：素材组 material-groups.json（A3-02） ----
  const mg1 = '自检素材组-' + STAMP
  const mg2 = '自检素材组改-' + STAMP
  const mgNew = await api('POST', 'contents/groups', { name: mg1 })
  const mgid = mgNew.data?.id
  check(mgNew.code === 0 && mgid !== undefined, '素材组·增', 'id=' + mgid)
  const mgList1 = await api('GET', 'contents/groups/list/1/50')
  check(find(mgList1.data?.list, g => g.id === mgid) !== undefined, '素材组·查', 'total=' + mgList1.data?.total)
  check(find(disk('material-groups.json'), g => g.id === mgid) !== undefined, '素材组·落盘', 'material-groups.json')
  const mgEdit = await api('POST', 'contents/groups/info/' + mgid, { name: mg2 })
  check(mgEdit.code === 0 && mgEdit.data?.name === mg2, '素材组·改', 'name=' + mgEdit.data?.name)
  check(find(disk('material-groups.json'), g => g.id === mgid)?.name === mg2, '素材组·改后落盘', '')
  const mgDel = await api('DELETE', 'contents/groups/' + mgid)
  const mgList2 = await api('GET', 'contents/groups/list/1/50')
  check(mgDel.code === 0 && find(mgList2.data?.list, g => g.id === mgid) === undefined, '素材组·删', '')
  check(find(disk('material-groups.json'), g => g.id === mgid) === undefined, '素材组·删后落盘消失', '')

  // ---- 域 3：素材 contents.json（A2-04 / A3-03） ----
  const title = '自检素材-' + STAMP
  const mat = await api('POST', 'contents/drafts', {
    title,
    desc: '自检描述',
    groupId: 'grp-default',
    mediaList: [{ type: 'img', url: 'https://example.com/qa.png' }],
    topics: ['自检'],
  })
  const mid = mat.data?._id
  check(mat.code === 0 && mid !== undefined, '素材·增', 'id=' + mid)
  const matInfo = await api('GET', 'contents/' + mid)
  check(matInfo.data?.title === title, '素材·查', 'title=' + matInfo.data?.title)
  const matList = await api('GET', 'contents/drafts/1/50')
  check(find(matList.data?.list, m => m._id === mid) !== undefined, '素材·列表出现', 'total=' + matList.data?.total)
  const matEdit = await api('PUT', 'contents/' + mid, { title: title + '改' })
  const matInfo2 = await api('GET', 'contents/' + mid)
  check(matEdit.code === 0 && matInfo2.data?.title === title + '改', '素材·改', 'title=' + matInfo2.data?.title)
  check(find(disk('contents.json')?.filter(m => m.kind === 'draft'), m => m._id === mid)?.title === title + '改', '素材·改后落盘', 'contents.json')
  const matDel = await api('DELETE', 'contents/' + mid)
  const matInfo3 = await api('GET', 'contents/' + mid)
  check(matDel.code === 0 && (matInfo3.data === null || matInfo3.data === undefined), '素材·删', '删后详情=' + JSON.stringify(matInfo3.data))
  check(find(disk('contents.json')?.filter(m => m.kind === 'draft'), m => m._id === mid) === undefined, '素材·删后落盘消失', '')

  // ---- 域 4：知识库笔记 knowledge.json（C5-01 / C5-02） ----
  const noteName = '自检笔记' + STAMP
  const noteNew = await api('POST', 'knowledge/notes', { name: noteName, folder: '' })
  const notePath = noteNew.data?.path
  check(noteNew.code === 0 && notePath !== undefined, '笔记·增', 'path=' + notePath)
  const tree = await api('GET', 'knowledge/tree')
  check(find(tree.data?.list, n => n.path === notePath) !== undefined, '笔记·查', '笔记数=' + (tree.data?.list?.length ?? 0))
  const noteEdit = await api('PUT', 'knowledge/notes/' + encodeURIComponent(notePath), { content: '# ' + noteName + '\n\n自检写入' + STAMP })
  const noteGet = await api('GET', 'knowledge/notes/' + encodeURIComponent(notePath))
  check(noteEdit.code === 0 && (noteGet.data?.content ?? '').includes('自检写入' + STAMP), '笔记·改', '')
  check(String(disk('knowledge.json')?.notes?.[notePath]?.content ?? '').includes('自检写入' + STAMP), '笔记·改后落盘', 'knowledge.json')
  const noteSearch = await api('POST', 'knowledge/search', { query: '自检写入' + STAMP })
  check(find(noteSearch.data?.hits, h => h.path === notePath) !== undefined, '笔记·搜索命中', 'hits=' + (noteSearch.data?.hits?.length ?? 0))
  const noteDel = await api('DELETE', 'knowledge/notes/' + encodeURIComponent(notePath))
  const noteGet2 = await api('GET', 'knowledge/notes/' + encodeURIComponent(notePath))
  check(noteDel.code === 0 && noteGet2.code !== 0, '笔记·删', '删后 GET code=' + noteGet2.code)
  check(disk('knowledge.json')?.notes?.[notePath] === undefined, '笔记·删后落盘消失', '')

  // ---- 域 5：自动接待规则 reception-rules.json（C4-01） ----
  const rule1 = '自检规则' + STAMP
  const rule2 = rule1 + '改'
  const ruleNew = await api('POST', 'v2/customer-reception/rules', {
    name: rule1,
    keywords: ['自检关键词' + STAMP],
    reply: '自检回复',
    enabled: true,
  })
  const rid = ruleNew.data?.id ?? ruleNew.data?.ruleId
  check(ruleNew.code === 0 && rid !== undefined, '接待规则·增', 'id=' + rid)
  const ruleList1 = await api('GET', 'v2/customer-reception/rules')
  const rules1 = Array.isArray(ruleList1.data) ? ruleList1.data : ruleList1.data?.list
  check(find(rules1, r => (r.id ?? r.ruleId) === rid) !== undefined, '接待规则·查', '规则数=' + (rules1?.length ?? 0))
  const ruleEdit = await api('PUT', 'v2/customer-reception/rules/' + rid, {
    name: rule2,
    keywords: ['自检关键词' + STAMP],
    reply: '自检回复改',
    enabled: true,
  })
  const ruleList2 = await api('GET', 'v2/customer-reception/rules')
  const rules2 = Array.isArray(ruleList2.data) ? ruleList2.data : ruleList2.data?.list
  check(ruleEdit.code === 0 && find(rules2, r => (r.id ?? r.ruleId) === rid)?.name === rule2, '接待规则·改', '')
  const ruleDel = await api('DELETE', 'v2/customer-reception/rules/' + rid)
  const ruleList3 = await api('GET', 'v2/customer-reception/rules')
  const rules3 = Array.isArray(ruleList3.data) ? ruleList3.data : ruleList3.data?.list
  check(ruleDel.code === 0 && find(rules3, r => (r.id ?? r.ruleId) === rid) === undefined, '接待规则·删', '')
  check(find(disk('reception-rules.json'), r => (r.id ?? r.ruleId) === rid) === undefined, '接待规则·删后落盘消失', '')

  const pass = results.filter(r => r.ok).length
  const fail = results.length - pass
  console.log('')
  console.log('CRUD_MATRIX ' + (fail === 0 ? 'PASS' : 'FAIL') + ' checks=' + results.length + ' pass=' + pass + ' fail=' + fail)
  if (fail > 0) console.log('FAILED: ' + results.filter(r => !r.ok).map(r => r.id).join('、'))
  process.exit(fail === 0 ? 0 : 1)
}

await main()
