/**
 * A2 复核临时往返脚本（不入库）：以源码加载真实路由，数据根用临时目录，绝不触碰产品数据。
 * 生成长视频路径不调用内核模型；图片生成打本机 mock（/v1/images/generations），ffmpeg 走 FFMPEG_PATH。
 * 运行：node --import tsx/esm products/bosom-friend/.a2-verify/roundtrip.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { buildRoutes, matchRoute, segsOf } from '../server/src/api.ts'
import { openStore } from '../server/src/store.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
process.env.FFMPEG_PATH = join(repoRoot, 'products/bosom-friend/desktop/dist/runtime/ffmpeg.exe')

// ---- 64x64 PNG（真实解码器可读），供 mock 图片接口返回 ----------------------------
function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(size = 64) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) {
    const off = y * (size * 3 + 1)
    raw[off] = 0
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = 40; raw[off + 2 + x * 3] = 90; raw[off + 3 + x * 3] = 200
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const pngB64 = makePng().toString('base64')

const mock = createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    if (req.url?.includes('/images/generations')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: pngB64 }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise(r => mock.listen(0, '127.0.0.1', r))
const mockBase = 'http://127.0.0.1:' + String(mock.address().port)

const dataRoot = mkdtempSync(join(tmpdir(), 'a2-verify-'))
mkdirSync(dataRoot, { recursive: true })
// 产品上传目录由上传路由创建；这里预建，等价于「用户先上传过一次」的真实环境。
mkdirSync(join(dataRoot, 'uploads'), { recursive: true })
process.on('unhandledRejection', (reason) => { console.log('UNHANDLED_REJECTION ' + String(reason)); process.exit(3) })
writeFileSync(join(dataRoot, 'llm-user.json'), JSON.stringify({
  baseUrl: mockBase, apiKey: 'a2-key', model: 'a2-text-model',
  imageBaseUrl: mockBase, imageApiKey: 'a2-key', imageModel: 'a2-image-model',
}, null, 2))
const store = openStore(dataRoot)
const routes = buildRoutes({ dataRoot, store, security: {}, kernelAi: false })
const log = (label, value) => console.log(label + ' ' + (typeof value === 'string' ? value : JSON.stringify(value)))

function makeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    writeHead(status) { out.status = status },
    setHeader() {},
    write() {},
    end(chunk) { if (chunk !== undefined) out.body += String(chunk) },
    on() {},
    pipe() {},
  }
}
async function call(method, path, body) {
  const url = new URL(path, 'http://x')
  const match = matchRoute(routes, method, segsOf(url.pathname))
  if (match === undefined) return { status: 404, missing: true }
  const res = makeRes()
  const req = { method, url: url.pathname + url.search, headers: {} }
  await match.route.h({ req, res, params: match.params, query: url.searchParams, body })
  let json = null
  try { json = JSON.parse(res.out.body) } catch { json = null }
  return { status: res.out.status, json }
}
const rows = name => { const parsed = JSON.parse(readFileSync(join(dataRoot, name), 'utf8')); return Array.isArray(parsed) ? parsed : parsed.value }
const sleep = ms => new Promise(r => setTimeout(r, ms))

log('DATA_ROOT', dataRoot)
log('MOCK_IMAGE_BASE', mockBase)

// ---- GA-6：媒体列表只剩 asset；旧的 media/list 路由已不存在 ------------------------
const groupCreate = await call('POST', 'contents/groups', { name: 'A2 复核组' })
const groupId = groupCreate.json?.data?.id ?? ''
log('GA6_GROUP', { id: groupId, status: groupCreate.status })

// ---- GB-6：创建草稿（前端 useCreateMaterialForm 会带 accountTypes） ----------------
const draftCreate = await call('POST', 'contents/drafts', {
  groupId,
  title: 'A2 草稿',
  desc: '复核',
  accountTypes: ['douyin', 'xhs'],
  maxUseCountByAccountType: { douyin: 999, xhs: 999 },
  mediaList: [{ url: '/bosom-friend/api/assets/file/a2.png', type: 'img' }],
  type: 'normal',
})
log('GB6_CREATE_DRAFT_RESPONSE_ACCOUNTTYPES', draftCreate.json?.data?.accountTypes ?? null)
const draftId = draftCreate.json?.data?._id ?? ''
const draftList = await call('GET', 'contents/drafts/1/50?groupId=' + encodeURIComponent(groupId))
const listedDraft = (draftList.json?.data?.list ?? []).find(d => d._id === draftId)
log('GB6_RELIST_DRAFT_ACCOUNTTYPES', listedDraft?.accountTypes ?? null)

// ---- GB-8：草稿转移（前端 apiTransferMaterials → kind:'draft'） -------------------
const group2 = await call('POST', 'contents/groups', { name: 'A2 目标组' })
const targetGroupId = group2.json?.data?.id ?? ''
log('GB8_TRANSFER_DRAFT_RESPONSE', (await call('POST', 'contents/transfer', { ids: [draftId], targetGroupId, mode: 'move', kind: 'draft' })).json)
const afterTransfer = await call('GET', 'contents/drafts/1/50?groupId=' + encodeURIComponent(targetGroupId))
log('GB8_TARGET_GROUP_DRAFTS', { total: afterTransfer.json?.data?.total, ids: (afterTransfer.json?.data?.list ?? []).map(d => d._id) })
log('GB8_TRANSFER_WRONG_KIND_RESPONSE', (await call('POST', 'contents/transfer', { ids: [draftId], targetGroupId: groupId, mode: 'move', kind: 'asset' })).json)
log('GB8_TARGET_GROUP_DRAFTS_REREAD', { total: (await call('GET', 'contents/drafts/1/50?groupId=' + encodeURIComponent(targetGroupId))).json?.data?.total })

// ---- 生成长视频（duration=60 → 不调用内核模型；图片走 mock，视频走 ffmpeg） ---------
const genCreate = await call('POST', 'ai/draft-generation/v2', {
  groupId,
  prompt: 'A2 复核：重庆夜景打卡长视频',
  quantity: 1,
  imageCount: 3,
  platforms: ['douyin', 'xhs'],
  duration: 60,
  resolution: '720p',
  aspectRatio: '9:16',
})
const genId = genCreate.json?.data?.taskIds?.[0] ?? ''
log('GEN_CREATED', { status: genCreate.status, taskIds: genCreate.json?.data?.taskIds })
let gen = null
for (let i = 0; i < 160; i++) {
  await sleep(500)
  const list = await call('GET', 'ai/draft-generation?page=1&pageSize=50')
  gen = (list.json?.data?.list ?? []).find(g => g.id === genId)
  if (gen !== undefined && gen.status !== 'generating') break
}
log('GB4_GENERATION_RECORD', {
  status: gen?.status,
  errorMessage: gen?.errorMessage ?? null,
  requestImageCount: gen?.request?.imageCount ?? null,
  responseRequestedImageCount: gen?.response?.requestedImageCount ?? null,
  responseGeneratedImageCount: gen?.response?.generatedImageCount ?? null,
  imageUrls: gen?.response?.imageUrls?.length ?? 0,
  videoUrl: gen?.response?.videoUrl ?? null,
  queue: gen?.queue ?? null,
})
const genDraft = rows('contents.json').find(item => item.kind === 'draft' && item.metadata?.generationId === genId)
log('GB6_GENERATED_DRAFT', {
  found: genDraft !== undefined,
  accountTypes: genDraft?.accountTypes ?? null,
  generationParams: genDraft?.generationParams ?? null,
})

// ---- GA-6：媒体列表（assets）与草稿列表互不污染 ------------------------------------
const assetsPage = await call('GET', 'contents/assets/1/50?groupId=' + encodeURIComponent(groupId))
const assetRows = assetsPage.json?.data?.list ?? []
log('GA6_ASSETS_LIST', {
  total: assetsPage.json?.data?.total,
  returned: assetRows.length,
  uniqueIds: new Set(assetRows.map(r => r._id)).size,
  sources: [...new Set(assetRows.map(r => r.source))],
  containsDraftRows: assetRows.some(r => rows('contents.json').find(c => c._id === r._id)?.kind === 'draft'),
})
const mediaListRoute = await call('GET', 'media/list/1/50')
log('GA6_LEGACY_MEDIA_LIST_ROUTE', { missing: mediaListRoute.missing === true, status: mediaListRoute.status })

// ---- GA-5：删除被生成记录引用的素材（媒体库「删除」走的就是这条） ------------------
const protectedAsset = assetRows.find(a => rows('contents.json').find(c => c._id === a._id)?.metadata?.generationId !== undefined)
log('GA5_TARGET_PROTECTED_ASSET', { id: protectedAsset?._id ?? null, url: protectedAsset?.url ?? null })
if (protectedAsset !== undefined) {
  log('GA5_DELETE_RESPONSE', (await call('DELETE', 'contents', { ids: [protectedAsset._id], kind: 'asset' })).json)
  const reRead = await call('GET', 'contents/assets/1/50?groupId=' + encodeURIComponent(groupId))
  log('GA5_AFTER_REREAD_PROTECTED', {
    total: reRead.json?.data?.total,
    stillThere: (reRead.json?.data?.list ?? []).some(a => a._id === protectedAsset._id),
    onDisk: rows('contents.json').some(c => c._id === protectedAsset._id),
  })
}

// ---- GA-5：删除未被生成记录引用的素材（应真删，重读不回魂） -------------------------
const contentsNow = rows('contents.json')
contentsNow.unshift({
  kind: 'asset', _id: 'cnt-a2-free', userId: 'zy-user-001', groupId, type: 'img',
  url: '/bosom-friend/api/assets/file/a2-free.png', thumbUrl: '/bosom-friend/api/assets/file/a2-free.png',
  title: 'A2 未被引用的素材', desc: '', useCount: 0, metadata: {}, createdAt: new Date().toISOString(),
})
writeFileSync(join(dataRoot, 'contents.json'), JSON.stringify({ schemaVersion: 1, value: contentsNow }, null, 2) + '\n')
log('GA5_DELETE_FREE_RESPONSE', (await call('DELETE', 'contents', { ids: ['cnt-a2-free'], kind: 'asset' })).json)
const reRead2 = await call('GET', 'contents/assets/1/50?groupId=' + encodeURIComponent(groupId))
log('GA5_AFTER_REREAD_FREE', {
  stillThere: (reRead2.json?.data?.list ?? []).some(a => a._id === 'cnt-a2-free'),
  onDisk: rows('contents.json').some(c => c._id === 'cnt-a2-free'),
})
log('DONE', true)
mock.close()
process.exit(0)
