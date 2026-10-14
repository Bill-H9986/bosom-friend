/**
 * 抖音原始接口探针（只读 GET，不改数据、不发布）：确认账号资料与作品互动字段在平台侧到底有没有。
 * 用最近一次同步落盘的 cookie 调两个创作者接口，只打印字段与数值，绝不打印 cookie。
 * 用法：node products/bosom-friend/qa/probes/probe-douyin-raw.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const syncRoot = join(homedir(), '.bosom-friend', 'bosom-friend', 'platform-login', 'sync')
const dirs = readdirSync(syncRoot).map(name => ({ name, path: join(syncRoot, name), mtime: statSync(join(syncRoot, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)
let storage = null
for (const dir of dirs) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir.path, 'storage.json'), 'utf8'))
    if (Array.isArray(parsed.cookies) && parsed.cookies.length > 0 && parsed.cookies.some(c => String(c.domain ?? '').includes('douyin'))) { storage = { dir: dir.name, cookies: parsed.cookies }; break }
  }
  catch { /* 不是浏览器存储格式就跳过 */ }
}
if (storage === null) {
  console.log('NO_DOUYIN_STORAGE')
  process.exit(0)
}
const cookieHeader = storage.cookies.filter(c => String(c.domain ?? '').includes('douyin')).map(c => c.name + '=' + c.value).join('; ')
console.log('using sync dir: ' + storage.dir + ' (cookies=' + storage.cookies.length + ')')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const get = async (url) => {
  const response = await fetch(url, { headers: { Cookie: cookieHeader, 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: 'https://creator.douyin.com/' }, signal: AbortSignal.timeout(20000) })
  const text = await response.text()
  try { return { http: response.status, json: JSON.parse(text) } }
  catch { return { http: response.status, json: null, head: text.slice(0, 200) } }
}

const info = await get('https://creator.douyin.com/web/api/media/user/info/')
console.log('\n=== user/info ===')
console.log('http=' + info.http + ' status_code=' + (info.json?.status_code ?? '?'))
const user = info.json?.user ?? {}
console.log('user keys: ' + Object.keys(user).join(','))
console.log('nickname=' + JSON.stringify(user.nickname) + '  unique_id=' + JSON.stringify(user.unique_id) + '  follower_count=' + user.follower_count)

const list = await get('https://creator.douyin.com/aweme/v1/creator/item/list/?cursor=0')
console.log('\n=== creator/item/list ===')
console.log('http=' + list.http + ' status_code=' + (list.json?.status_code ?? '?') + ' keys=' + Object.keys(list.json ?? {}).join(','))
const items = list.json?.aweme_list ?? list.json?.item_info_list ?? []
console.log('items=' + items.length)
if (items.length > 0) {
  const first = items[0]
  console.log('item keys: ' + Object.keys(first).join(','))
  const stats = first.statistics ?? {}
  console.log('statistics keys: ' + Object.keys(stats).join(','))
  console.log('statistics values: ' + JSON.stringify(stats))
  console.log('desc=' + JSON.stringify(String(first.desc ?? '').slice(0, 40)))
}
