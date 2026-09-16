/* oxlint-disable no-non-null-assertion, restrict-plus-operands, no-unnecessary-condition, no-unnecessary-type-conversion, no-unnecessary-type-assertion, no-unnecessary-type-parameters, require-await, @stylistic/max-len -- 结构保证型规则：路由段由匹配器确保存在、JSON 文件由 JsonFile 确保可读；中文文案/资源 URL 为长单串，属产品文案而非可拆分语句 */
/**
 * 内容域路由：素材/媒体库、OSS 三步直传、数据统计看板、话题搜索、
 * 笔记互动搜索、热榜内容、抖音小程序与用户反馈。
 * @module @deepseek-ai/dsh-bosom-friend-server/routes-content
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { RouteDef, Deps } from './api.ts'
import { PUBLISH_RECORD_STATUS, type ZyContentKind } from './types.ts'
import { streamLlmWithDeltas, parseLlmOverride, readStoredLlm } from './api.ts'
import { uploadsMeta } from './api.ts'
import { extractVideoThumbnail } from './platform-login.ts'
import { mimeOfExt, writeOk } from './http.ts'
import { nowIso, uid, readString, writeFailRaw } from './store-helper.ts'
import { DEFAULT_MATERIAL_GROUP_ID, filterGenerationArtifacts } from './store.ts'
import { getInteractionState, newInteractionTaskId, startPlatformInteraction } from './platform-interactions.ts'
import {
  markReceptionPending,
  matchReception,
  triggerReceptionNow,
  updateReceptionConfig,
} from './reception-engine.ts'
import {
  attachReceptionConversation,
  clearReceptionReplies,
  listReceptionReplies,
  recordReceptionReply,
} from './reception-replies.ts'

/**
 * 追加内容域路由。
 * @param deps - 共享依赖。
 * @param routes - 待追加的路由数组。
 */
export function appendContentRoutes(deps: Deps, routes: RouteDef[]): void {
  const files = deps.store.files

  /** 热榜卡片最小契约（与前端 HotContentFeedItem 对齐）。 */
  interface HotContentFeedItem {
    rank: number
    title: string
    description?: string
    heatText?: string
    targetUrl?: string
  }

  // ---- 外部公开数据源（成熟开源聚合接口） -------------------------------------
  // uapis.cn 的 hotboard/aggregate 是公开聚合接口，不需要密钥；失败时返回
  // “暂不可用”，绝不生成示例数据冒充实时结果。
  const UAPI_HOTBOARD_URL = 'https://uapis.cn/api/v1/misc/hotboard'
  const UAPI_SEARCH_URL = 'https://uapis.cn/api/v1/search/aggregate'
  const UAPI_SOURCE_TYPE: Record<string, string> = {
    weibo: 'weibo',
    douyin: 'douyin',
    xhs: 'xiaohongshu',
    zhihu: 'zhihu',
    bilibili: 'bilibili',
  }
  const HOTBOARD_CACHE_TTL_MS = 5 * 60 * 1000
  const hotboardCache = new Map<string, { at: number; feed: { items: HotContentFeedItem[]; updatedAt: string } }>()

  function normalizeHotSourceKey(sourceKey: string): string {
    const key = sourceKey.split(':')[0]?.toLowerCase() ?? sourceKey
    return key === 'xiaohongshu' ? 'xhs' : key
  }

  interface UapiHotRow {
    index?: unknown
    title?: unknown
    url?: unknown
    hot_value?: unknown
  }

  async function fetchUapiHotboard(type: string): Promise<{ items: HotContentFeedItem[]; updatedAt: string } | null> {
    const cacheKey = type
    const cached = hotboardCache.get(cacheKey)
    if (cached && Date.now() - cached.at < HOTBOARD_CACHE_TTL_MS)
      return cached.feed
    try {
      const response = await fetch(`${UAPI_HOTBOARD_URL}?type=${encodeURIComponent(type)}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json' },
      })
      if (!response.ok)
        return null
      const payload = await response.json() as { list?: UapiHotRow[]; update_time?: unknown }
      const rows = Array.isArray(payload.list) ? payload.list : []
      const feed = {
        items: rows
          .map((row, index): HotContentFeedItem => ({
            rank: Number(row.index ?? index + 1) || index + 1,
            title: typeof row.title === 'string' ? row.title : '',
            heatText: row.hot_value === undefined ? '' : String(row.hot_value),
            targetUrl: typeof row.url === 'string' ? row.url : '',
          }))
          .filter(item => item.title !== ''),
        updatedAt: typeof payload.update_time === 'string' ? payload.update_time : nowIso(),
      }
      hotboardCache.set(cacheKey, { at: Date.now(), feed })
      return feed
    }
    catch {
      return null
    }
  }

  async function fetchUapiSearch(query: string, page: number, limit: number): Promise<{ items: Array<Record<string, unknown>>; total: number } | null> {
    if (query.trim() === '')
      return null
    try {
      const response = await fetch(UAPI_SEARCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query,
          site: 'xiaohongshu.com',
          page,
          limit: Math.max(1, Math.min(50, limit)),
          timeout_ms: 20_000,
        }),
        signal: AbortSignal.timeout(25_000),
      })
      if (!response.ok)
        return null
      const payload = await response.json() as { results?: unknown; total_results?: unknown }
      const results = Array.isArray(payload.results) ? payload.results : []
      return {
        items: results.map(item => {
          const rec = (item ?? {}) as Record<string, unknown>
          return {
            noteIdKey: `uapi-${encodeURIComponent(query).slice(0, 16)}-${page}-${String(rec.position ?? (results.indexOf(item) + 1))}`,
            title: typeof rec.title === 'string' ? rec.title : '',
            snippet: typeof rec.snippet === 'string' ? rec.snippet : '',
            url: typeof rec.url === 'string' ? rec.url : '',
            publishTime: typeof rec.publish_time === 'string' ? rec.publish_time : '',
            source: typeof rec.source === 'string' ? rec.source : '',
          }
        }) as Array<Record<string, unknown>>,
        total: Number(payload.total_results ?? results.length) || results.length,
      }
    }
    catch {
      return null
    }
  }

  function toSampleNote(item: Record<string, unknown>): Record<string, unknown> {
    return {
      NoteIdKey: item.noteIdKey,
      Title: item.title,
      CoverImage: '',
      NoteType: 'link',
      NoteTypeDesc: '全网搜索',
      Tags: [],
      PublishTime: item.publishTime ? String(item.publishTime).slice(0, 10) : '',
      BloggerNickName: item.title,
      BloggerSmallAvatar: '',
      BloggerUrl: item.url,
      BloggerProp: '全网采集',
      CountDesc: '',
      LikedCountDesc: '',
      FavoritesCountDesc: '',
      CommentsCountDesc: '',
      ShareCountDesc: '',
      FansGroup: '',
      DateCode: '',
      SourceUrl: item.url,
      SourceSnippet: item.snippet,
      CollectedByAgent: true,
    }
  }

  async function hotFeedOrEmpty(sourceKey: string, itemLimit: number): Promise<{ items: HotContentFeedItem[]; freshness: 'fresh' | 'unavailable'; updatedAt: string; isSample: false }> {
    const normalized = normalizeHotSourceKey(sourceKey)
    const type = UAPI_SOURCE_TYPE[normalized]
    if (type === undefined)
      return { items: [], freshness: 'unavailable', updatedAt: nowIso(), isSample: false }
    const feed = await fetchUapiHotboard(type)
    if (feed === null)
      return { items: [], freshness: 'unavailable', updatedAt: nowIso(), isSample: false }
    return {
      items: feed.items.slice(0, Math.max(1, Math.min(100, itemLimit))),
      freshness: 'fresh',
      updatedAt: feed.updatedAt,
      isSample: false,
    }
  }

  // ---- OSS 三步直传 -------------------------------------------------------

  function uploadDir(): string {
    const dir = join(deps.dataRoot, 'uploads')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 生成一次上传票据（素材 id + 上传地址）。私有与公开两种寻址共用这一份逻辑：
   * 带 publicUploadId 走公开地址，否则走私有地址——此前两条 uploadSign 路由各写一遍。
   *
   * @param body - 上传请求体；`filename` 决定扩展名，`publicUploadId` 决定寻址形式。
   * @returns 素材 id 与上传地址。
   */
  const uploadTicket = (body: unknown): { id: string; uploadUrl: string } => {
    const filename = readString(body, 'filename', 'file')
    const id = uid('asset') + extname(filename)
    const publicId = readString(body, 'publicUploadId', '')
    const prefix = publicId === ''
      ? '/bosom-friend/api/assets/upload/'
      : '/bosom-friend/api/assets/public/' + publicId + '/upload/'
    return { id, uploadUrl: prefix + (publicId === '' ? id : encodeURIComponent(id)) }
  }

  const startUpload = (res: import('node:http').ServerResponse, body: unknown): void => {
    const ticket = uploadTicket(body)
    writeOk(res, { id: ticket.id, url: '', uploadUrl: ticket.uploadUrl })
  }

  const saveUploaded = (id: string, buffer: Buffer, contentType: string): void => {
    if (contentType !== '') uploadsMeta.set(id, contentType)
    writeFileSync(join(uploadDir(), id), buffer)
  }

  routes.push(
    {
      m: 'POST',
      p: 'assets/uploadSign',
      h: async ({ res, body }) => { startUpload(res, body) },
    },
    {
      m: 'POST',
      p: 'assets/public/:publicUploadId/uploadSign',
      h: ({ res, params, body }) => {
        // 与私有上传同一份票据逻辑，只把路径里的 publicUploadId 合进请求体（去重，见 uploadTicket）。
        const ticket = uploadTicket({ ...(body as Record<string, unknown>), publicUploadId: params.publicUploadId })
        writeOk(res, { id: ticket.id, url: '', uploadUrl: ticket.uploadUrl })
      },
    },
    {
      // 路由器已把二进制请求体读为 Buffer（readBody 对 multipart 透传原样字节）。
      m: 'PUT',
      p: 'assets/upload/:assetId',
      h: ({ req, res, params, body }) => {
        saveUploaded(params.assetId!, body as Buffer, req.headers['content-type'] ?? '')
        res.writeHead(200)
        res.end()
      },
    },
    {
      m: 'PUT',
      p: 'assets/public/:publicUploadId/upload/:assetId',
      h: ({ req, res, params, body }) => {
        saveUploaded(params.assetId!, body as Buffer, req.headers['content-type'] ?? '')
        res.writeHead(200)
        res.end()
      },
    },
    {
      m: 'POST',
      p: 'assets/:assetId/confirm',
      h: ({ res, params }) => {
        const url = '/bosom-friend/api/assets/file/' + encodeURIComponent(params.assetId!)
        registerMaterialIfMedia(deps, params.assetId!, url)
        writeOk(res, { url })
      },
    },
    {
      m: 'POST',
      p: 'assets/public/:publicUploadId/:assetId/confirm',
      h: ({ res, params }) => {
        const url = '/bosom-friend/api/assets/file/' + encodeURIComponent(params.assetId!)
        registerMaterialIfMedia(deps, params.assetId!, url)
        writeOk(res, { url })
      },
    },
    {
      m: 'GET',
      p: 'assets/file/:assetId',
      h: ({ req, res, params }) => {
        const file = join(uploadDir(), params.assetId!)
        if (!existsSync(file)) { writeFailRaw(res, 'asset not found', 40404); return }
        const storedMime = uploadsMeta.get(params.assetId!) ?? ''
        const contentType = storedMime !== '' ? storedMime : mimeOfExt(extname(file))
        const stat = statSync(file)
        const range = req.headers.range
        if (range !== undefined) {
          const match = /bytes=(\d*)-(\d*)/.exec(range)
          if (match !== null) {
            const start = match[1] !== '' ? Number(match[1]) : 0
            const end = match[2] !== '' ? Number(match[2]) : stat.size - 1
            if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size && end < stat.size) {
              // 视频预填/seek 依赖 HTTP Range（206 分段），否则 <video> 元数据加载后 seek 永不触发
              res.writeHead(206, {
                'content-type': contentType,
                'accept-ranges': 'bytes',
                'content-range': `bytes ${start}-${end}/${stat.size}`,
                'content-length': end - start + 1,
                'cache-control': 'public, max-age=3600',
              })
              createReadStream(file, { start, end }).pipe(res)
              return
            }
          }
        }
        res.writeHead(200, {
          'content-type': contentType,
          'accept-ranges': 'bytes',
          'content-length': stat.size,
          'cache-control': 'public, max-age=3600',
        })
        createReadStream(file).pipe(res)
      },
    },
    {
      m: 'GET',
      p: 'assets/thumbnail',
      h: async ({ res, query }) => {
        const url = query.get('url') ?? ''
        let thumbnailUrl = url
        if (/^\/bosom-friend\/api\/assets\/file\//.test(url) && /\.(mp4|mov|webm|mkv)$/i.test(url)) {
          thumbnailUrl = (await extractVideoThumbnail(deps, url)) ?? ''
        }
        writeOk(res, { thumbnailUrl })
      },
    },

    // ---- 媒体库 --------------------------------------------------------------

    {
      m: 'GET',
      p: 'contents/assets/:pageNo/:pageSize',
      h: ({ res, params, query }) => {
        const pageNo = Math.max(1, Number(params.pageNo) || 1)
        const pageSize = Math.max(1, Number(params.pageSize) || 10)
        // 媒体库只返回 kind='asset' 的文件素材（上传与生成写入）；草稿走 contents。
        const materialRows: Array<Record<string, unknown>> = files.contents.load()
          .filter(item => item.kind === 'asset')
          .map(item => ({ ...item, source: 'material' }))
        let list: Array<Record<string, unknown>> = [...materialRows]
        const groupId = query.get('groupId')
        const type = query.get('type')
        if (groupId != null && groupId !== '') list = list.filter(m => String(m.groupId ?? '') === groupId)
        if (type != null && type !== '') list = list.filter(m => String(m.type ?? '') === type)
        const slice = list.slice((pageNo - 1) * pageSize, pageNo * pageSize).map(item => ({
          _id: String(item._id ?? ''),
          userId: String(item.userId ?? ''),
          userType: 'user',
          groupId: String(item.groupId ?? ''),
          type: String(item.type ?? ''),
          url: String(item.url ?? ''),
          thumbUrl: String(item.thumbUrl ?? ''),
          title: String(item.title ?? ''),
          desc: String(item.desc ?? ''),
          useCount: Number(item.useCount ?? 0),
          metadata: item.metadata ?? {},
          source: String(item.source ?? 'material'),
          createdAt: String(item.createdAt ?? ''),
          updatedAt: String(item.createdAt ?? ''),
        }))
        writeOk(res, { list: slice, total: list.length })
      },
    },
    // ---- 素材分组与素材 -------------------------------------------------------

    {
      m: 'GET',
      p: 'contents/groups/by-scene',
      h: ({ res, query }) => {
        const scene = query.get('useScene')
        const groups = files.materialGroups.load()
        const group = groups.find(g => g.useScene === scene) ?? groups[0]
        writeOk(res, group ? { id: group.id, name: group.name, useScene: group.useScene, useSceneRelId: group.useSceneRelId } : null)
      },
    },
    {
      m: 'GET',
      p: 'contents/drafts/optimal',
      h: ({ res, query }) => {
        const groupId = query.get('groupId') ?? ''
        const list = files.contents.load().filter(p => p.kind === 'draft' && p.groupId === groupId)
        if (list.length === 0) { writeOk(res, null); return }
        const optimal = [...list].sort((a, b) => (a.useCount ?? 0) - (b.useCount ?? 0))[0]
        writeOk(res, optimal)
      },
    },
    {
      m: 'POST',
      p: 'contents/groups',
      h: ({ res, body }) => {
        const groups = files.materialGroups.load()
        const name = readString(body, 'name', '新素材组')
        const group = {
          id: uid('mg'),
          name,
          title: name,
          desc: readString(body, 'desc'),
          platform: readString(body, 'platform'),
          useScene: readString(body, 'useScene'),
          useSceneRelId: readString(body, 'useSceneRelId'),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          mediaCount: 0,
        }
        groups.unshift(group)
        files.materialGroups.save(groups)
        writeOk(res, { id: group.id })
      },
    },
    {
      m: 'DELETE',
      p: 'contents/groups/filter',
      h: ({ res, body }) => {
        applyPromotionFilterDelete(deps, body)
        writeOk(res, true)
      },
    },
    {
      m: 'DELETE',
      p: 'contents/groups/:id',
      h: ({ res, params }) => {
        const groups = files.materialGroups.load()
        const idx = groups.findIndex(g => g.id === params.id)
        if (idx < 0) { writeFailRaw(res, '素材组不存在或已被删除', 40404); return }
        groups.splice(idx, 1)
        files.materialGroups.save(groups)
        writeOk(res, true)
      },
    },
    {
      m: 'POST',
      p: 'contents/groups/info/:id',
      h: ({ res, params, body }) => {
        const groups = files.materialGroups.load()
        const group = groups.find(g => g.id === params.id)
        if (group !== undefined) {
          const name = readString(body, 'name')
          if (name !== '') { group.name = name; group.title = name }
          group.updatedAt = nowIso()
          files.materialGroups.save(groups)
        }
        writeOk(res, group ?? null)
      },
    },
    {
      m: 'GET',
      p: 'contents/groups/info/:id',
      h: ({ res, params }) => {
        const group = files.materialGroups.load().find(g => g.id === params.id)
        if (group === undefined) {
          writeOk(res, null)
          return
        }
        const mediaCount = files.contents.load().filter(p => p.kind === 'draft' && p.groupId === group.id).length
        writeOk(res, { ...group, mediaCount })
      },
    },
    {
      m: 'GET',
      p: 'contents/groups/list/:pageNo/:pageSize',
      h: ({ res, params }) => {
        const pageNo = Math.max(1, Number(params.pageNo) || 1)
        const pageSize = Math.max(1, Number(params.pageSize) || 10)
        // 默认素材组恒排第一：它承载用户既有内容，是内容创作首屏的落点。
        // 新建组一律插在队首（POST contents/groups），若不在这里纠正顺序，
        // 任何一个后建的组（含验收脚本建的临时组）都会把首屏顶成一个空组——用户看到「什么都没有」。
        const all = [...files.materialGroups.load()].sort((a, b) =>
          Number(b.id === DEFAULT_MATERIAL_GROUP_ID) - Number(a.id === DEFAULT_MATERIAL_GROUP_ID))
        const drafts = files.contents.load().filter(p => p.kind === 'draft')
        const slice = all.slice((pageNo - 1) * pageSize, pageNo * pageSize).map(g => ({
          ...g,
          isDefault: g.id === DEFAULT_MATERIAL_GROUP_ID,
          mediaCount: drafts.filter(p => p.groupId === g.id).length,
          statistics: { materialCount: drafts.filter(p => p.groupId === g.id).length, publishCount: 0, viewCount: 0, likeCount: 0, commentCount: 0, shareCount: 0, favoriteCount: 0 },
        }))
        writeOk(res, { list: slice, total: all.length })
      },
    },
    {
      m: 'POST',
      p: 'contents/drafts',
      h: ({ res, body }) => {
        writeOk(res, createPromotion(deps, body))
      },
    },
    {
      m: 'DELETE',
      p: 'contents',
      h: ({ res, body }) => {
        const params = body as { ids?: unknown; kind?: unknown }
        const ids = Array.isArray(params.ids) ? params.ids as string[] : []
        // 素材与草稿的批量删除语义不同（素材要保护被生成记录引用的文件，草稿要级联清理生成），
        // 合并成一条路径后必须由调用方显式声明 kind，不做隐式默认。
        if (params.kind === 'asset') { writeOk(res, removeMaterials(deps, ids)); return }
        if (params.kind === 'draft') {
          const deleted = deletePromotions(deps, ids)
          // 一条都没删掉时不许回成功：那正是"点了删除、界面说好了、记录还在"的来源。
          if (deleted === 0) { writeFailRaw(res, '这些草稿不存在或已被删除', 40404); return }
          writeOk(res, { deleted })
          return
        }
        writeFailRaw(res, 'contents 批量删除需要显式 kind（asset | draft）', 40000)
      },
    },
    {
      m: 'DELETE',
      p: 'contents/drafts/filter',
      h: ({ res, body }) => {
        applyPromotionFilterDelete(deps, body)
        writeOk(res, true)
      },
    },
    {
      m: 'POST',
      p: 'contents/transfer',
      h: ({ res, body }) => {
        const kind = (body as { kind?: unknown }).kind
        if (kind !== 'asset' && kind !== 'draft') {
          writeFailRaw(res, 'contents/transfer 需要显式 kind（asset | draft）', 40000)
          return
        }
        writeOk(res, transferMaterials(deps, body, kind))
      },
    },
    {
      m: 'DELETE',
      p: 'contents/:id',
      h: ({ res, params }) => {
        const list = files.contents.load()
        const idx = list.findIndex(p => p.kind === 'draft' && p._id === params.id)
        // 找不到就如实报"不存在"，不再回 code:0 + data:false 让前端当成功关掉弹窗。
        // 删到了仍回 `true`：这是既有契约（E2E 与调用方都按 true 判定），
        // 诚实性由失败分支保证，不需要顺带改成功载荷的形状。
        if (idx < 0) { writeFailRaw(res, '草稿不存在或已被删除', 40404); return }
        list.splice(idx, 1)
        files.contents.save(list)
        writeOk(res, true)
      },
    },
    {
      m: 'PUT',
      p: 'contents/:id',
      h: ({ res, params, body }) => {
        updatePromotion(deps, params.id!, body)
        writeOk(res, true)
      },
    },
    {
      m: 'GET',
      p: 'contents/:id',
      h: ({ res, params }) => {
        writeOk(res, files.contents.load().find(p => p.kind === 'draft' && p._id === params.id) ?? null)
      },
    },
    {
      m: 'GET',
      p: 'contents/drafts/:pageNo/:pageSize',
      h: ({ res, params, query }) => {
        const pageNo = Math.max(1, Number(params.pageNo) || 1)
        const pageSize = Math.max(1, Number(params.pageSize) || 10)
        let list = files.contents.load().filter(p => p.kind === 'draft')
        const groupId = query.get('groupId')
        const title = query.get('title')
        if (groupId != null && groupId !== '') list = list.filter(p => p.groupId === groupId)
        if (title != null && title !== '') list = list.filter(p => (p.title ?? '').includes(title))
        writeOk(res, { list: list.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: list.length })
      },
    },
    // ---- 统计 -----------------------------------------------------------------

    {
      m: 'POST',
      p: 'statistics/channels/douyin/searchTopic',
      h: ({ res }) => {
        // 抖音话题搜索需平台签名接口；未接入时返回空列表，不伪造“话题建议”。
        writeOk(res, [])
      },
    },
    {
      m: 'GET',
      p: 'v2/statistics/published-content-summary/dashboard',
      h: ({ res, query }) => {
        // 平台侧已删除的作品不进统计（同步对账标记，见 platform-sync.reconcileRemovedWorks）。
        const allRecords = files.records.load()
        const removedWorkIds = new Set(
          allRecords
            .filter(r => r.removedOnPlatform === true && r.platformWorkId !== undefined)
            .map(r => String(r.platformWorkId)),
        )
        const records = allRecords.filter(r => r.status === PUBLISH_RECORD_STATUS.PUBLISHED && r.removedOnPlatform !== true)
        const metrics = files.metrics.load().filter(m => !removedWorkIds.has(String(m.workId)))
        const platformsParam = query.get('platforms')
        const platformSet = platformsParam != null && platformsParam !== '' ? new Set(platformsParam.split(',')) : undefined
        const accountIdParam = query.get('accountId')
        const accountIdSet = accountIdParam != null && accountIdParam !== '' ? new Set([accountIdParam]) : undefined
        const startDate = query.get('startDate')
        const endDate = query.get('endDate')
        const inRange = (r: import('./types.ts').ZyPublishRecord): boolean => (!platformSet || platformSet.has(String(r.accountType))) && (!accountIdSet || accountIdSet.has(String(r.accountId)))
        const dateInRange = (value?: string | Date): boolean => {
          if (startDate == null && endDate == null)
            return true
          const day = String(value ?? '').slice(0, 10)
          if (day === '')
            return false
          return (startDate == null || day >= startDate) && (endDate == null || day <= endDate)
        }
        const published = records.filter(r => inRange(r) && dateInRange(r.publishTime))
        const matchingMetrics = metrics.filter(m => (!accountIdSet || accountIdSet.has(String(m.accountId))) && dateInRange(m.date))
        // 平台是否提供了某项指标、没值时又是哪种"没有值"：只用采样行判定，不替平台下结论。
        // 抖音创作者 work_list 对同一批 15 条作品返回 statistics.play_count=0，而
        // digg_count/comment_count/share_count 有真值；同一批作品历史同步曾采到真实播放量
        // （state.json 2026-09-02：13016/10329/9384/5654…）。全 0 因此既不能当"确实是 0"，
        // 也不能当"平台未提供"。没有采样行时不下任何结论：availability 与 reason 均为 undefined。
        const metricAvailability = matchingMetrics.length === 0
          ? undefined
          : {
              views: matchingMetrics.some(m => metricValue(m, 'viewCount') > 0),
              likes: matchingMetrics.some(m => metricValue(m, 'likeCount') > 0),
              comments: matchingMetrics.some(m => metricValue(m, 'commentCount') > 0),
              shares: matchingMetrics.some(m => metricValue(m, 'shareCount') > 0),
              favorites: matchingMetrics.some(m => metricValue(m, 'favoriteCount') > 0),
            }
        /**
         * 每项指标没值的原因，供前端区分「本次未采到」与「无判定信号」：
         * - available：有非 0 采样值。
         * - not-collected-this-sync：该项全 0，同批其它互动指标有真值，说明本次只缺这一项，可重新同步。
         *   点赞/评论/分享有值却 0 播放在同一作品上不可能同时为真，因此不能展示成平台真值 0。
         * - no-signal：全部互动指标都是 0，没有差分证据，不声称"平台不提供"。
         */
        const METRIC_AVAILABILITY_KEYS = ['views', 'likes', 'comments', 'shares', 'favorites'] as const
        type MetricAvailability = Record<(typeof METRIC_AVAILABILITY_KEYS)[number], boolean>
        const metricReason = (availability: MetricAvailability, key: keyof MetricAvailability): 'available' | 'not-collected-this-sync' | 'no-signal' => {
          if (availability[key])
            return 'available'
          return METRIC_AVAILABILITY_KEYS.some(other => other !== key && availability[other]) ? 'not-collected-this-sync' : 'no-signal'
        }
        const metricAvailabilityReason = metricAvailability === undefined
          ? undefined
          : {
              views: metricReason(metricAvailability, 'views'),
              likes: metricReason(metricAvailability, 'likes'),
              comments: metricReason(metricAvailability, 'comments'),
              shares: metricReason(metricAvailability, 'shares'),
              favorites: metricReason(metricAvailability, 'favorites'),
            }
        const growthKeys = ['viewGrowth', 'likeGrowth', 'commentGrowth', 'shareGrowth', 'favoriteGrowth'] as const
        const overall: Record<string, number | string> = {
          workCount: published.length,
          publishedWorkCount: published.length,
        }
        for (const key of growthKeys) overall[key] = sumMetric(matchingMetrics, keyToMetric(key))

        const dayMs = 86400000
        let rangeStart: Date
        let rangeEnd: Date
        if (startDate != null || endDate != null) {
          rangeEnd = endDate != null ? new Date(endDate) : new Date()
          rangeStart = startDate != null ? new Date(startDate) : new Date(rangeEnd.getTime() - 13 * dayMs)
          if (Number.isNaN(rangeEnd.getTime()))
            rangeEnd = new Date()
          if (Number.isNaN(rangeStart.getTime()))
            rangeStart = new Date(rangeEnd.getTime() - 13 * dayMs)
        }
        else {
          rangeEnd = new Date()
          rangeStart = new Date(rangeEnd.getTime() - 13 * dayMs)
        }
        const days: string[] = []
        for (let cursor = new Date(rangeStart); cursor <= rangeEnd; cursor = new Date(cursor.getTime() + dayMs))
          days.push(cursor.toISOString().slice(0, 10))
        const growthTrend = days.map((date) => {
          const row: Record<string, string | number> = { date, workCount: published.filter(r => String(r.publishTime).slice(0, 10) <= date).length }
          for (const key of growthKeys) row[key] = matchingMetrics.filter(m => m.date === date).reduce((acc, m) => acc + metricValue(m, keyToMetric(key)), 0)
          return row
        })

        const platformNames = [...new Set(published.map(r => String(r.accountType)))]
        const platformContribution = platformNames.map((platform) => {
          const row: Record<string, string | number> = { platform, count: published.filter(r => r.accountType === platform).length }
          for (const key of growthKeys) row[key] = sumMetric(matchingMetrics.filter(m => m.platform === platform), keyToMetric(key))
          return row
        })
        const platformEfficiency = platformNames.map((platform) => {
          const count = published.filter(r => r.accountType === platform).length || 1
          const views = sumMetric(matchingMetrics.filter(m => m.platform === platform), 'viewCount')
          const likes = sumMetric(matchingMetrics.filter(m => m.platform === platform), 'likeCount')
          const comments = sumMetric(matchingMetrics.filter(m => m.platform === platform), 'commentCount')
          return { platform, count, avgViews: Math.round(views / count), avgLikes: Math.round(likes / count), avgComments: Math.round(comments / count) }
        })
        const workStats = published.slice(0, 12).map(r => ({
          dataId: String(r.platformWorkId ?? r.id),
          platform: r.accountType,
          title: r.title,
          coverUrl: r.coverUrl,
          url: r.workLink,
          publishedAt: r.publishTime,
          viewGrowth: engagementValue(r, 'viewCount'),
          likeGrowth: engagementValue(r, 'likeCount'),
          commentGrowth: engagementValue(r, 'commentCount'),
          shareGrowth: engagementValue(r, 'shareCount'),
          favoriteGrowth: engagementValue(r, 'favoriteCount'),
          contributionRate: Math.round((engagementValue(r, 'viewCount') / (sumMetric(matchingMetrics, 'viewCount') || 1)) * 1000) / 10,
        }))
        const byView = [...workStats].sort((a, b) => b.viewGrowth - a.viewGrowth)
        const matchedWorkIds = new Set(matchingMetrics.map(m => String(m.workId)))
        /**
         * 一次采样是否采到了真值：平台只回了 0（占位）不算「已更新」——
         * 行存在只说明对上了 workId，不代表拿到了数据（DEF-020：全 0 占位曾被算作已更新）。
         *
         * @param workId - 平台作品 id。
         * @returns 该作品在本次范围内的指标里是否存在任意一个非 0 值。
         */
        const sampledRealValue = (workId: string): boolean => matchingMetrics
          .filter(metric => String(metric.workId) === workId)
          .some(metric => ['viewCount', 'likeCount', 'commentCount', 'shareCount', 'favoriteCount']
            .some(key => metricValue(metric, key) > 0))
        const matchedWorks = published.filter(r => matchedWorkIds.has(String(r.platformWorkId ?? r.id)))
        const updatedWorks = matchedWorks.filter(r => sampledRealValue(String(r.platformWorkId ?? r.id)))
        writeOk(res, {
          overall,
          metricAvailability,
          metricAvailabilityReason,
          growthTrend,
          platformContribution,
          platformEfficiency,
          topWorks: { byViewGrowth: byView, byLikeGrowth: [...workStats].sort((a, b) => b.likeGrowth - a.likeGrowth), byCommentGrowth: [...workStats].sort((a, b) => b.commentGrowth - a.commentGrowth), byShareGrowth: [...workStats].sort((a, b) => b.shareGrowth - a.shareGrowth), byFavoriteGrowth: [...workStats].sort((a, b) => b.favoriteGrowth - a.favoriteGrowth) },
          updateProgress: {
            totalCount: published.length,
            updatedCount: updatedWorks.length,
            zeroOnlyCount: matchedWorks.length - updatedWorks.length,
          },
          dataUpdatedAt: nowIso(),
        })
      },
    },

    // ---- 笔记互动搜索 ----------------------------------------------------------

    {
      m: 'POST',
      p: 'v2/statistics/note-comment-search/options',
      h: ({ res }) => {
        writeOk(res, {
          noteTypes: [{ Value: 1, Label: '图文笔记' }, { Value: 2, Label: '视频笔记' }],
          bloggerProps: [{ Value: 1, Label: '素人' }, { Value: 2, Label: '腰部达人' }, { Value: 3, Label: '头部达人' }],
          noteTags: [{ Id: 't-food', Name: '美食' }, { Id: 't-travel', Name: '旅行' }, { Id: 't-beauty', Name: '美妆', Children: [{ Id: 't-beauty-skin', Name: '护肤' }] }],
          sortOptions: [{ Value: 1, Label: '综合排序' }, { Value: 2, Label: '最新发布' }, { Value: 3, Label: '点赞最多' }],
        })
      },
    },
    {
      m: 'POST',
      p: 'v2/statistics/note-comment-search/search',
      h: async ({ res, body }) => {
        const page = Math.max(1, Number((body as { page?: unknown }).page ?? 1) || 1)
        const pageSize = Math.max(1, Number((body as { pageSize?: unknown }).pageSize ?? 20) || 20)
        const keyword = readString(body, 'keyword').trim()
        if (keyword === '') {
          writeFailRaw(res, '请输入要搜索的小红书内容关键词', 40000)
          return
        }
        const result = await fetchUapiSearch(keyword, page, pageSize)
        if (result === null) {
          writeFailRaw(res, '全网搜索服务暂不可用，请稍后重试', 50000)
          return
        }
        writeOk(res, {
          list: result.items.map(toSampleNote),
          total: result.total,
          page,
          pageSize,
          isSample: false,
          maxExportCount: Math.max(0, result.total),
          source: 'uapi-search',
        })
      },
    },
    {
      m: 'POST',
      p: 'v2/statistics/note-comment-search/agent-collect',
      h: async ({ res, body }) => {
        const keyword = readString(body, 'keyword').trim()
        if (keyword === '') {
          writeOk(res, { insight: '请输入关键词后再采集，当前没有可分析的内容', items: [], collectedAt: nowIso(), source: 'agent', isSample: false })
          return
        }
        const result = await fetchUapiSearch(keyword, 1, 20)
        if (result === null) {
          writeOk(res, { insight: 'AI 全网采集服务暂不可用，本次没有生成任何结论', items: [], collectedAt: nowIso(), source: 'agent', isSample: false })
          return
        }
        writeOk(res, {
          insight: `已从全网采集 ${result.total} 条与「${keyword}」相关的小红书内容，结果均保留原文链接。`,
          items: result.items.map(toSampleNote),
          collectedAt: nowIso(),
          source: 'agent',
          isSample: false,
        })
      },
    },
    {
      m: 'POST',
      p: 'v2/statistics/note-comment-search/note-simple-info',
      h: async ({ res, body }) => {
        const noteId = readString(body, 'noteid').trim()
        if (noteId === '') {
          writeFailRaw(res, '缺少笔记标识', 40000)
          return
        }
        const result = await fetchUapiSearch(noteId, 1, 5)
        const first = result?.items[0]
        if (first === undefined) {
          writeOk(res, { NoteIdKey: noteId, Title: '', LikedCountDesc: '', available: false, reason: '公开聚合源未找到该笔记详情' })
          return
        }
        writeOk(res, {
          NoteIdKey: noteId,
          Title: first.title,
          LikedCountDesc: '',
          Fans: '',
          NoteCount: '',
          BlogLevelName: '全网采集',
          SourceUrl: first.url,
          SourceSnippet: first.snippet,
          available: true,
        })
      },
    },
    { m: 'POST', p: 'v2/statistics/note-comment-search/note-analyse', h: ({ res }) => { writeOk(res, { trend: [], available: false, reason: '公开聚合源不含单篇互动趋势' }) } },
    { m: 'POST', p: 'v2/statistics/note-comment-search/note-hot-words', h: ({ res }) => { writeOk(res, { list: [], available: false, reason: '公开聚合源不含评论热词' }) } },
    { m: 'POST', p: 'v2/statistics/note-comment-search/comment-ment-stat', h: ({ res }) => { writeOk(res, { list: [], positive: 0, neutral: 0, negative: 0, available: false, reason: '评论情感统计需要平台登录态' }) } },
    {
      m: 'POST',
      p: 'v2/statistics/note-comment-search/note-comments',
      h: ({ res }) => {
        writeOk(res, { list: [], total: 0, available: false, reason: '评论明细需要真实登录态，当前公开聚合源未提供' })
      },
    },
    {
      m: 'POST',
      p: 'v2/statistics/note-comment-search/xhs-url',
      h: ({ res, body }) => {
        writeOk(res, { url: 'https://www.xiaohongshu.com/explore/' + readString(body, 'noteId') })
      },
    },
    { m: 'POST', p: 'v2/statistics/note-comment-search/export', h: ({ res }) => { writeOk(res, { list: [], available: false, reason: '导出已改为前端使用已展示的真实搜索结果，无需后端占位接口' }) } },

    // ---- 热榜内容 ---------------------------------------------------------------

    {
      m: 'GET',
      p: 'v2/hot-content/categories',
      h: ({ res }) => {
        writeOk(res, [{ cid: 1, name: '综合' }, { cid: 2, name: '科技' }, { cid: 3, name: '生活' }])
      },
    },
    {
      m: 'GET',
      p: 'v2/hot-content/home/sources',
      h: ({ res }) => {
        writeOk(res, hotSources())
      },
    },
    {
      m: 'GET',
      p: 'v2/hot-content/categories/:cid/sources',
      h: ({ res }) => {
        const sources = hotSources()
        writeOk(res, { list: sources, total: sources.length })
      },
    },
    {
      m: 'GET',
      p: 'v2/hot-content/sources/search',
      h: ({ res, query }) => {
        const q = query.get('q') ?? ''
        writeOk(res, { list: hotSources().filter(s => s.name.includes(q) || s.sourceKey.includes(q.toLowerCase())), total: hotSources().length })
      },
    },
    {
      m: 'GET',
      p: 'v2/hot-content/sources/:sourceKey/context',
      h: ({ res, params }) => {
        const source = hotSources().find(s => s.sourceKey === normalizeHotSourceKey(params.sourceKey ?? '')) ?? hotSources()[0]
        writeOk(res, { source, siblings: hotSources() })
      },
    },
    {
      m: 'GET',
      p: 'v2/hot-content/sources/:sourceKey/feed',
      h: async ({ res, params, query }) => {
        const itemLimit = Math.max(1, Number(query.get('itemLimit') ?? 10) || 10)
        writeOk(res, await hotFeedOrEmpty(params.sourceKey ?? '', itemLimit))
      },
    },

    // ---- 抖音小程序 & 反馈 ---------------------------------------------------------

    {
      m: 'POST',
      p: 'plat/douyin/miniapp-auth/complete',
      h: ({ res }) => { writeFailRaw(res, '抖音小程序授权完成回调尚未接入，当前不会伪装成功', 50100) },
    },
    {
      m: 'GET',
      p: 'plat/douyin-miniapp/homepage-data/fans-count',
      h: ({ res, query }) => {
        // 抖音粉丝增长曲线需小程序官方数据授权；未接入时如实返回空，不画全 0 的假曲线。
        const dateType = Number(query.get('dateType') ?? 7) || 7
        writeOk(res, { scope: 'ma.user.data', dateType, list: [], available: false })
      },
    },
    {
      m: 'POST',
      p: 'contact/feedback',
      h: async ({ res, body }) => {
        const record = JSON.stringify({ ...body as Record<string, unknown>, receivedAt: nowIso() }) + '\n'
        try {
          // 建目录与追加都放进 try：任一失败都必须让用户看得见。
          mkdirSync(deps.dataRoot, { recursive: true })
          appendFileSync(join(deps.dataRoot, 'feedback.jsonl'), record, 'utf8')
        } catch (error) {
          // 以前这里吞掉异常照样回 sent:true：用户以为反馈发出去了，实际被丢掉。
          // 反馈是用户对我们唯一的直接信号，丢了必须说，不能假装成功。
          writeFailRaw(res, '反馈未能保存：' + (error instanceof Error ? error.message : String(error)), 50000)
          return
        }
        writeOk(res, { sent: true })
      },
    },

    // ---- 自动接待（customer-reception） --------------------------------------------

    {
      m: 'GET',
      p: 'v2/customer-reception/rules',
      h: ({ res }) => {
        writeOk(res, files.receptionRules.load())
      },
    },
    {
      m: 'POST',
      p: 'v2/customer-reception/rules',
      h: ({ res, body }) => {
        const rules = files.receptionRules.load()
        const params = (body ?? {}) as Partial<import('./types.ts').ReceptionRule>
        const rule: import('./types.ts').ReceptionRule = {
          id: uid('rule'),
          name: typeof params.name === 'string' ? params.name : '未命名规则',
          ...(typeof params.accountId === 'string' && params.accountId !== '' ? { accountId: params.accountId } : {}),
          platforms: Array.isArray(params.platforms) ? params.platforms : [],
          keywords: Array.isArray(params.keywords) ? params.keywords : [],
          matchMode: params.matchMode === 'all' ? 'all' : 'any',
          excludeKeywords: Array.isArray(params.excludeKeywords) ? params.excludeKeywords : [],
          ...(typeof params.cooldownMinutes === 'number' ? { cooldownMinutes: params.cooldownMinutes } : {}),
          replyMode: params.replyMode === 'ai' ? 'ai' : 'template',
          template: typeof params.template === 'string' ? params.template : '',
          ...(typeof params.aiModel === 'string' ? { aiModel: params.aiModel } : {}),
          ...(typeof params.systemPrompt === 'string' ? { systemPrompt: params.systemPrompt } : {}),
          enabled: params.enabled !== false,
          priority: typeof params.priority === 'number' ? params.priority : rules.length + 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        rules.push(rule)
        files.receptionRules.save(rules)
        writeOk(res, rule)
      },
    },
    {
      m: 'PUT',
      p: 'v2/customer-reception/rules/:ruleId',
      h: ({ res, params, body }) => {
        const rules = files.receptionRules.load()
        const rule = rules.find(r => r.id === params.ruleId)
        if (rule === undefined) { writeFailRaw(res, 'rule not found', 40404); return }
        const patch = (body ?? {}) as Record<string, unknown>
        for (const key of ['name', 'template', 'aiModel', 'systemPrompt'] as const) {
          if (typeof patch[key] === 'string') Object.assign(rule, { [key]: patch[key] })
        }
        if (typeof patch.accountId === 'string' && patch.accountId !== '') rule.accountId = patch.accountId
        else if (typeof patch.accountId === 'string' && patch.accountId === '') delete rule.accountId
        if (Array.isArray(patch.platforms)) rule.platforms = patch.platforms as string[]
        if (Array.isArray(patch.keywords)) rule.keywords = patch.keywords as string[]
        if (patch.matchMode === 'any' || patch.matchMode === 'all') rule.matchMode = patch.matchMode
        if (Array.isArray(patch.excludeKeywords)) rule.excludeKeywords = patch.excludeKeywords as string[]
        if (typeof patch.cooldownMinutes === 'number') rule.cooldownMinutes = patch.cooldownMinutes
        if (patch.replyMode === 'ai' || patch.replyMode === 'template') rule.replyMode = patch.replyMode
        if (typeof patch.enabled === 'boolean') rule.enabled = patch.enabled
        if (typeof patch.priority === 'number') rule.priority = patch.priority
        rule.updatedAt = nowIso()
        files.receptionRules.save(rules)
        writeOk(res, rule)
      },
    },
    {
      m: 'DELETE',
      p: 'v2/customer-reception/rules/:ruleId',
      h: ({ res, params }) => {
        const rules = files.receptionRules.load().filter(r => r.id !== params.ruleId)
        files.receptionRules.save(rules)
        writeOk(res, { ok: true })
      },
    },
    {
      m: 'POST',
      p: 'v2/customer-reception/test',
      h: ({ res, body }) => {
        const params = (body ?? {}) as { message?: unknown; platform?: unknown; accountId?: unknown }
        writeOk(res, matchReception(files, {
          message: typeof params.message === 'string' ? params.message : '',
          ...(typeof params.platform === 'string' ? { platform: params.platform } : {}),
          ...(typeof params.accountId === 'string' && params.accountId !== '' ? { accountId: params.accountId } : {}),
        }))
      },
    },
    {
      m: 'POST',
      p: 'v2/customer-reception/suggest',
      h: async ({ res, body }) => {
        const params = body as { message?: unknown; platform?: unknown; accountId?: unknown; llm?: unknown }
        const message = typeof params.message === 'string' ? params.message : ''
        const result = matchReception(files, {
          message,
          ...(typeof params.platform === 'string' ? { platform: params.platform } : {}),
          ...(typeof params.accountId === 'string' && params.accountId !== '' ? { accountId: params.accountId } : {}),
        })
        let reply = result.reply ?? ''
        let aiUsed = result.aiUsed === true
        // 只生成建议草稿，不写日志、不发送；无用户钥匙时如实返回空建议。
        if (reply === '' && message !== '') {
          try {
            const llm = await streamLlmWithDeltas('请以客服口吻简洁回复访客问题（80字内）：' + message, undefined, parseLlmOverride(params.llm) ?? readStoredLlm(deps.dataRoot))
            if (llm.text !== '') { reply = llm.text; aiUsed = true }
          } catch { /* 钥匙不可达：返回空建议由前端提示配置 */ }
        }
        writeOk(res, {
          matched: result.matched,
          ruleId: result.ruleId,
          ruleName: result.rule?.name,
          reply,
          aiUsed,
        })
      },
    },
    // ---- 平台互动（评论/私信）真实执行：全部走真实浏览器 + 登录态 -----------------
    {
      m: 'POST',
      p: 'v2/customer-reception/interactions/list',
      h: ({ res, body }) => {
        const params = body as { platform?: unknown; accountId?: unknown; kind?: unknown; workId?: unknown; workTitle?: unknown; createTime?: unknown }
        const platform = typeof params.platform === 'string' ? params.platform : ''
        const accountId = typeof params.accountId === 'string' ? params.accountId : ''
        const kind = params.kind === 'dm' ? 'dm' : 'comment'
        if (platform === '' || accountId === '') { writeFailRaw(res, '缺少平台或账号', 40000); return }
        const taskId = newInteractionTaskId()
        const started = startPlatformInteraction(deps, taskId, {
          op: kind === 'dm' ? 'dm_list' : 'comments_list',
          platform,
          accountId,
          workId: typeof params.workId === 'string' ? params.workId : '',
          workTitle: typeof params.workTitle === 'string' ? params.workTitle : '',
          createTime: typeof params.createTime === 'string' ? params.createTime : '',
        })
        if (!started.ok) { writeFailRaw(res, started.error, 50000); return }
        writeOk(res, { ok: true, taskId })
      },
    },
    {
      m: 'POST',
      p: 'v2/customer-reception/interactions/reply',
      h: ({ res, body }) => {
        const params = body as { platform?: unknown; accountId?: unknown; kind?: unknown; workId?: unknown; workTitle?: unknown; commentText?: unknown; username?: unknown; sessionId?: unknown; peerName?: unknown; replyText?: unknown }
        const platform = typeof params.platform === 'string' ? params.platform : ''
        const accountId = typeof params.accountId === 'string' ? params.accountId : ''
        const kind = params.kind === 'dm' ? 'dm' : 'comment'
        if (platform === '' || accountId === '') { writeFailRaw(res, '缺少平台或账号', 40000); return }
        const replyText = typeof params.replyText === 'string' ? params.replyText : ''
        if (replyText.trim() === '') { writeFailRaw(res, '回复内容为空', 40000); return }
        const taskId = newInteractionTaskId()
        const started = startPlatformInteraction(deps, taskId, {
          op: kind === 'dm' ? 'dm_reply' : 'comment_reply',
          platform,
          accountId,
          workId: typeof params.workId === 'string' ? params.workId : '',
          workTitle: typeof params.workTitle === 'string' ? params.workTitle : '',
          commentText: typeof params.commentText === 'string' ? params.commentText : '',
          username: typeof params.username === 'string' ? params.username : '',
          sessionId: typeof params.sessionId === 'string' ? params.sessionId : '',
          peerName: typeof params.peerName === 'string' ? params.peerName : '',
          replyText,
        })
        if (!started.ok) { writeFailRaw(res, started.error, 50000); return }
        // 发起即沉淀「客户 + 原文 + AI 回复」，成功与否由平台任务状态核对后回写。
        recordReceptionReply(deps, {
          taskId,
          platform,
          accountId,
          kind,
          replyText,
          ...(typeof params.workId === 'string' && params.workId !== '' ? { workId: params.workId } : {}),
          ...(typeof params.workTitle === 'string' && params.workTitle !== '' ? { workTitle: params.workTitle } : {}),
          ...(typeof params.commentText === 'string' && params.commentText !== '' ? { commentText: params.commentText } : {}),
          ...(typeof params.username === 'string' && params.username !== '' ? { username: params.username } : {}),
          ...(typeof params.sessionId === 'string' && params.sessionId !== '' ? { sessionId: params.sessionId } : {}),
          ...(typeof params.peerName === 'string' && params.peerName !== '' ? { peerName: params.peerName } : {}),
        })
        writeOk(res, { ok: true, taskId })
      },
    },
    {
      m: 'GET',
      p: 'v2/customer-reception/interactions/:taskId',
      h: ({ res, params }) => {
        const taskId = params.taskId ?? ''
        const state = getInteractionState(deps, taskId)
        if (state === undefined) { writeFailRaw(res, 'task not found', 40404); return }
        writeOk(res, state)
      },
    },
    {
      m: 'GET',
      p: 'v2/customer-reception/replies',
      h: ({ res, query }) => {
        const kind = query.get('kind') === 'dm' ? 'dm' as const : query.get('kind') === 'comment' ? 'comment' as const : undefined
        const statusRaw = query.get('status')
        const status = statusRaw === 'sending' || statusRaw === 'succeeded' || statusRaw === 'failed' ? statusRaw : undefined
        const limitRaw = Number(query.get('limit') ?? 300)
        writeOk(res, listReceptionReplies(deps, {
          ...(query.get('platform') != null && query.get('platform') !== '' ? { platform: query.get('platform')! } : {}),
          ...(query.get('accountId') != null && query.get('accountId') !== '' ? { accountId: query.get('accountId')! } : {}),
          ...(kind === undefined ? {} : { kind }),
          ...(status === undefined ? {} : { status }),
          ...(query.get('q') != null && query.get('q') !== '' ? { keyword: query.get('q')! } : {}),
          ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
        }))
      },
    },
    {
      m: 'DELETE',
      p: 'v2/customer-reception/replies',
      h: ({ res }) => {
        writeOk(res, { ok: true, cleared: clearReceptionReplies(deps) })
      },
    },
    {
      // 「查看原对话」：拉起平台读取任务（私信读整段会话，评论读该作品评论线程）。
      m: 'POST',
      p: 'v2/customer-reception/conversation',
      h: ({ res, body }) => {
        const params = body as { platform?: unknown; accountId?: unknown; kind?: unknown; sessionId?: unknown; peerName?: unknown; workId?: unknown; workTitle?: unknown; createTime?: unknown; commentKey?: unknown; commentText?: unknown; username?: unknown }
        const platform = typeof params.platform === 'string' ? params.platform : ''
        const accountId = typeof params.accountId === 'string' ? params.accountId : ''
        const kind = params.kind === 'comment' ? 'comment' as const : 'dm' as const
        if (platform === '' || accountId === '') { writeFailRaw(res, '缺少平台或账号', 40000); return }
        const taskId = newInteractionTaskId()
        const started = startPlatformInteraction(deps, taskId, {
          op: 'conversation',
          platform,
          accountId,
          kind,
          ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
          ...(typeof params.peerName === 'string' ? { peerName: params.peerName } : {}),
          ...(typeof params.workId === 'string' ? { workId: params.workId } : {}),
          ...(typeof params.workTitle === 'string' ? { workTitle: params.workTitle } : {}),
          ...(typeof params.createTime === 'string' ? { createTime: params.createTime } : {}),
          ...(typeof params.commentText === 'string' ? { commentText: params.commentText } : {}),
          ...(typeof params.username === 'string' ? { username: params.username } : {}),
        })
        if (!started.ok) { writeFailRaw(res, started.error, 50000); return }
        writeOk(res, { ok: true, taskId })
      },
    },
    {
      // 读取原对话任务结果；done 时把平台快照挂到对应回复记录上（可按 replyId 关联）。
      m: 'GET',
      p: 'v2/customer-reception/conversation/:taskId',
      h: ({ res, params, query }) => {
        const state = getInteractionState(deps, params.taskId ?? '')
        if (state === undefined) { writeFailRaw(res, 'task not found', 40404); return }
        if (state.status !== 'done') {
          writeOk(res, { status: state.status ?? 'starting', error: state.error ?? '' })
          return
        }
        const data = (state.data ?? {}) as {
          ok?: boolean
          kind?: string
          messages?: { from?: string; text?: string; time?: string }[]
          comment?: { commentText?: string; username?: string; hasReply?: boolean }
          replyText?: string
          message?: string
        }
        const kind: 'comment' | 'dm' = data.kind === 'comment' ? 'comment' : 'dm'
        const messages = kind === 'dm'
          ? (data.messages ?? []).map(row => ({
            from: row.from === 'me' ? 'me' as const : row.from === 'customer' ? 'customer' as const : 'unknown' as const,
            text: String(row.text ?? ''),
            ...(row.time === undefined || row.time === '' ? {} : { time: row.time }),
          }))
          : [
            { from: 'customer' as const, text: String(data.comment?.commentText ?? '') },
            ...(typeof data.replyText === 'string' && data.replyText !== '' ? [{ from: 'me' as const, text: data.replyText }] : []),
          ]
        const snapshot = {
          at: nowIso(),
          source: 'platform' as const,
          kind,
          messages,
          ...(kind === 'comment'
            ? { note: data.comment === undefined ? '平台评论列表中未找到这条评论（可能已删除）' : data.comment.hasReply === true ? '平台显示该评论下已有回复' : '平台显示该评论下暂无回复' }
            : {}),
          ...(data.message === undefined || data.message === '' ? {} : { note: data.message }),
        }
        const replyId = query.get('replyId') ?? ''
        if (replyId !== '') attachReceptionConversation(deps, replyId, snapshot)
        writeOk(res, { status: 'done', snapshot, ok: data.ok !== false })
      },
    },
    {
      m: 'GET',
      p: 'v2/customer-reception/status',
      h: ({ res }) => {
        writeOk(res, files.receptionStatus.load())
      },
    },
    {
      m: 'POST',
      p: 'v2/customer-reception/config',
      h: ({ res, body }) => {
        const params = body as { intervalMinutes?: unknown; seenWindowMinutes?: unknown; cooldownMinutes?: unknown; maxPendingPerRound?: unknown }
        const config = updateReceptionConfig(deps, {
          ...(typeof params.intervalMinutes === 'number' ? { intervalMinutes: params.intervalMinutes } : {}),
          ...(typeof params.seenWindowMinutes === 'number' ? { seenWindowMinutes: params.seenWindowMinutes } : {}),
          ...(typeof params.cooldownMinutes === 'number' ? { cooldownMinutes: params.cooldownMinutes } : {}),
          ...(typeof params.maxPendingPerRound === 'number' ? { maxPendingPerRound: params.maxPendingPerRound } : {}),
        })
        writeOk(res, config)
      },
    },
    {
      m: 'GET',
      p: 'v2/customer-reception/pending',
      h: ({ res }) => {
        writeOk(res, files.receptionPending.load().slice(0, 200))
      },
    },
    {
      m: 'POST',
      p: 'v2/customer-reception/pending/:pendingId/status',
      h: ({ res, params, body }) => {
        const input = body as { status?: unknown; error?: unknown; sentText?: unknown }
        const status = input.status === 'processing' || input.status === 'succeeded' || input.status === 'failed' || input.status === 'skipped' ? input.status : undefined
        if (status === undefined) { writeFailRaw(res, '待办状态必须是 processing/succeeded/failed/skipped', 40000); return }
        const item = markReceptionPending(
          deps,
          params.pendingId ?? '',
          status,
          typeof input.error === 'string' ? input.error : undefined,
          typeof input.sentText === 'string' ? input.sentText : undefined,
        )
        if (item === undefined) { writeFailRaw(res, '待办不存在', 40404); return }
        writeOk(res, item)
      },
    },
    {
      m: 'GET',
      p: 'v2/customer-reception/works/:accountId',
      h: ({ res, params }) => {
        const accountId = params.accountId ?? ''
        const works = new Map<string, { workId: string; title?: string; createTime?: string }>()
        for (const rec of files.records.load()) {
          if (rec.accountId !== accountId || typeof rec.platformWorkId !== 'string' || rec.platformWorkId === '') continue
          if (!works.has(rec.platformWorkId)) {
            works.set(rec.platformWorkId, {
              workId: rec.platformWorkId,
              ...(typeof rec.title === 'string' ? { title: rec.title } : {}),
              createTime: rec.publishTime,
            })
          }
        }
        for (const row of files.metrics.load()) {
          if (row.accountId !== accountId || typeof row.workId !== 'string' || row.workId === '') continue
          if (!works.has(row.workId)) works.set(row.workId, { workId: row.workId })
        }
        writeOk(res, [...works.values()].slice(0, 20))
      },
    },
    {
      m: 'POST',
      p: 'v2/customer-reception/poll-now',
      h: ({ res }) => {
        // triggered=false 表示引擎正在跑这一轮，这次点击没有启动新的一轮（前端据此如实提示）。
        writeOk(res, { ok: true, triggered: triggerReceptionNow(deps) })
      },
    },
  )


  // ---- 局部工具 ---------------------------------------------------------------

  /**
   * 删除素材：生成记录仍引用的文件保留，返回实际删除与被保留的 id。
   *
   * 返回值是调用方更新列表的唯一依据：被保留的素材不能在前端乐观移除，
   * 否则刷新后卡片原样回来。
   */
  function removeMaterials(d: Deps, ids: string[]): { deleted: string[]; kept: string[] } {
    const contents = d.store.files.contents.load()
    const assets = contents.filter(item => item.kind === 'asset')
    const generationUrls = new Set<string>()
    for (const gen of d.store.files.generations.load()) {
      const response = gen.response as { imageUrls?: unknown; coverUrl?: unknown; videoUrl?: unknown } | undefined
      if (Array.isArray(response?.imageUrls)) {
        for (const url of response.imageUrls) {
          if (typeof url === 'string')
            generationUrls.add(url)
        }
      }
      if (typeof response?.coverUrl === 'string' && response.coverUrl !== '')
        generationUrls.add(response.coverUrl)
      if (typeof response?.videoUrl === 'string' && response.videoUrl !== '')
        generationUrls.add(response.videoUrl)
    }
    // 生成记录仍引用的媒体不允许从素材库单独删除；用户删除生成记录时由
    // “删除生成记录”接口统一清理，避免历史记录出现断图/断视频。
    // url 对 asset 记录必有值，这里的兜底空串只是 ZyContentRecord 可选字段的类型收窄。
    const kept = contents.filter(item =>
      item.kind !== 'asset' || !ids.includes(item._id) || generationUrls.has(item.url ?? ''),
    )
    d.store.files.contents.save(kept)
    // 被删媒体所属生成记录若无任何剩余产物，级联删除该生成记录，避免“删了又回来”。
    const removed = assets.filter(m => ids.includes(m._id) && !kept.includes(m))
    const orphanGenerations = new Set<string>()
    for (const gone of removed) {
      const gid = (gone.metadata as { generationId?: unknown } | undefined)?.generationId
      if (typeof gid !== 'string' || orphanGenerations.has(gid)) continue
      const stillReferenced = kept.some(m => (m.metadata as { generationId?: unknown } | undefined)?.generationId === gid)
      if (!stillReferenced) orphanGenerations.add(gid)
    }
    cascadeRemoveGenerations(d, orphanGenerations)
    // kept 只包含「仍在库里的请求 id」，即被生成记录引用而未被删除的那些；
    // 不存在的 id 既不算删除也不算保留，避免把无效请求报成受保护。
    const remaining = new Set(kept.filter(item => item.kind === 'asset').map(item => item._id))
    return { deleted: removed.map(m => m._id), kept: ids.filter(id => remaining.has(id)) }
  }

  function transferMaterials(d: Deps, body: unknown, kind: ZyContentKind): { count: number } {
    const params = body as { ids?: unknown; targetGroupId?: unknown }
    const ids = (params.ids ?? []) as string[]
    const targetGroupId = typeof params.targetGroupId === 'string' ? params.targetGroupId : DEFAULT_MATERIAL_GROUP_ID
    const contents = d.store.files.contents.load()
    let count = 0
    for (const item of contents) {
      if (item.kind === kind && ids.includes(item._id)) { item.groupId = targetGroupId; count++ }
    }
    d.store.files.contents.save(contents)
    return { count }
  }

  function createPromotion(d: Deps, body: unknown): Record<string, unknown> {
    const params = body as { groupId?: unknown; title?: unknown; desc?: unknown; mediaList?: unknown; topics?: unknown; type?: unknown; coverUrl?: unknown; accountTypes?: unknown }
    const contents = d.store.files.contents.load()
    // 目标平台由用户在选择器里勾选：草稿详情的平台图标与按平台用量都读这一字段，必须落盘。
    const accountTypes = Array.isArray(params.accountTypes)
      ? params.accountTypes.filter((type): type is string => typeof type === 'string' && type !== '')
      : []
    const promotion = {
      kind: 'draft' as const,
      _id: uid('cnt'),
      id: '',
      groupId: typeof params.groupId === 'string' ? params.groupId : DEFAULT_MATERIAL_GROUP_ID,
      title: typeof params.title === 'string' ? params.title : '未命名素材',
      desc: typeof params.desc === 'string' ? params.desc : '',
      coverUrl: typeof params.coverUrl === 'string' ? params.coverUrl : firstImageUrl(params.mediaList),
      mediaList: Array.isArray(params.mediaList) ? params.mediaList as import('./types.ts').ZyMaterialMedia[] : [],
      topics: Array.isArray(params.topics) ? params.topics as string[] : [],
      ...(accountTypes.length > 0 ? { accountTypes } : {}),
      type: typeof params.type === 'string' ? params.type : 'normal',
      status: 0 as const,
      useCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    promotion.id = promotion._id
    contents.unshift(promotion)
    d.store.files.contents.save(contents)
    return promotion
  }

  function firstImageUrl(mediaList: unknown): string {
    if (!Array.isArray(mediaList)) return ''
    const found = mediaList.find(m => (m as { type?: string }).type === 'img') as { url?: string } | undefined
    return found?.url ?? ''
  }

  function updatePromotion(d: Deps, id: string, body: unknown): void {
    const contents = d.store.files.contents.load()
    const promotion = contents.find(p => p.kind === 'draft' && p._id === id)
    if (promotion === undefined) return
    Object.assign(promotion, body as Record<string, unknown>, { updatedAt: nowIso() })
    d.store.files.contents.save(contents)
  }

  /**
   * 批量删除草稿并级联清理其生成记录。
   *
   * @param d - 共享依赖。
   * @param ids - 要删除的草稿 id。
   * @returns 实际删掉的条数。调用方必须拿它回报真实结果——此前这里返回 void，
   *   路由只能一律回 "成功"，用户看到"已删除"而列表没变，分不清是没删掉还是没刷新。
   */
  function deletePromotions(d: Deps, ids: string[]): number {
    const contents = d.store.files.contents.load()
    const removed = contents.filter(p => p.kind === 'draft' && ids.includes(p._id))
    d.store.files.contents.save(contents.filter(p => p.kind !== 'draft' || !ids.includes(p._id)))
    const orphanGenerations = new Set<string>()
    for (const p of removed) {
      const gid = (p.metadata as { generationId?: unknown } | undefined)?.generationId
      if (typeof gid === 'string') orphanGenerations.add(gid)
    }
    cascadeRemoveGenerations(d, orphanGenerations)
    return removed.length
  }

  /** 级联删除生成记录及其全部草稿/媒体产物（用户删除任一记录即整个创作簇消失，不再回魂）。 */
  function cascadeRemoveGenerations(d: Deps, generationIds: Set<string>): void {
    if (generationIds.size === 0) return
    d.store.files.generations.save(d.store.files.generations.load().filter(g => !generationIds.has(g.id)))
    d.store.files.contents.save(filterGenerationArtifacts(generationIds, d.store.files.contents.load()))
  }

  function applyPromotionFilterDelete(d: Deps, body: unknown): void {
    const filter = body as { title?: unknown; groupId?: unknown; useCount?: unknown }
    const contents = d.store.files.contents.load()
    let list = contents.filter(p => p.kind === 'draft')
    if (typeof filter.title === 'string' && filter.title !== '') list = list.filter(p => !(p.title ?? '').includes(filter.title as string))
    else if (typeof filter.groupId === 'string' && filter.groupId !== '') list = list.filter(p => p.groupId !== filter.groupId)
    const kept = new Set(list.map(p => p._id))
    // 只删除命中的草稿，同一张表内的 asset 记录不受影响。
    d.store.files.contents.save(contents.filter(item => item.kind !== 'draft' || kept.has(item._id)))
  }

  function registerMaterialIfMedia(d: Deps, assetId: string, url: string): void {
    // 用户直传不写 uploadsMeta（进程内 Map，重启即失），必须按扩展名兜底——与 assets/file
    // 的服务路径同一判定，否则上传成功却登记不上，前端拿到 code=0 的假成功。
    const mime = uploadsMeta.get(assetId) ?? mimeOfExt(extname(assetId))
    const kind = mime.startsWith('image/') ? 'img' : mime.startsWith('video/') ? 'video' : undefined
    if (kind === undefined) return
    const contents = d.store.files.contents.load()
    contents.unshift({
      kind: 'asset',
      _id: assetId,
      userId: 'zy-user-001',
      groupId: DEFAULT_MATERIAL_GROUP_ID,
      type: kind,
      url,
      thumbUrl: kind === 'img' ? url : '',
      title: assetId.split('.')[0] ?? assetId,
      desc: '',
      useCount: 0,
      metadata: { mimeType: mime },
      createdAt: nowIso(),
    })
    d.store.files.contents.save(contents)
  }

  function hotSources(): { sourceKey: string; name: string; display: string; iconUrl: string; cid: number }[] {
    return [
      { sourceKey: 'weibo', name: '微博', display: '微博热搜', iconUrl: '', cid: 1 },
      { sourceKey: 'douyin', name: '抖音', display: '抖音热点', iconUrl: '', cid: 1 },
      { sourceKey: 'xhs', name: '小红书', display: '小红书热点', iconUrl: '', cid: 3 },
      { sourceKey: 'zhihu', name: '知乎', display: '知乎热榜', iconUrl: '', cid: 2 },
      { sourceKey: 'bilibili', name: 'B站', display: 'B站热榜', iconUrl: '', cid: 2 },
    ]
  }

  function keyToMetric(key: string): 'viewCount' | 'likeCount' | 'commentCount' | 'shareCount' | 'favoriteCount' {
    switch (key) {
      case 'viewGrowth': return 'viewCount'
      case 'likeGrowth': return 'likeCount'
      case 'commentGrowth': return 'commentCount'
      case 'shareGrowth': return 'shareCount'
      default: return 'favoriteCount'
    }
  }

  function metricValue(row: { viewCount?: number; likeCount?: number; commentCount?: number; shareCount?: number; favoriteCount?: number }, key: string): number {
    return (row as Record<string, number | undefined>)[key] ?? 0
  }

  function sumMetric(rows: { viewCount?: number; likeCount?: number; commentCount?: number; shareCount?: number; favoriteCount?: number }[], key: string): number {
    return rows.reduce((acc, row) => acc + metricValue(row, key), 0)
  }

  function engagementValue(record: unknown, key: string): number {
    const engagement = (record as { engagement?: Record<string, number> }).engagement
    return engagement?.[key] ?? 0
  }
}
