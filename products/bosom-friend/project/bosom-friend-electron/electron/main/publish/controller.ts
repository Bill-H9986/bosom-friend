/*
 * @Author: nevin
 * @Date: 2025-01-20 22:02:54
 * @LastEditTime: 2025-02-22 20:39:02
 * @LastEditors: nevin
 * @Description:
 */
import { getBackendBase } from '../config/backendBase'
import { logger } from '../../global/log'
import { Controller, Icp, Inject } from '../core/decorators';
import { PublishService } from './service';
import { getUserInfo, getUserToken } from '../user/comment';
import { AppDataSource } from '../../db';
import { Between, FindOptionsWhere } from 'typeorm';
import {
  backPageData,
  type CorrectQuery,
  type pubRecordListQuery,
} from '../../global/table';
import { PubRecordModel } from '../../db/models/pubRecord';
import { PubStatus, PubType } from '../../../commont/publish/PublishEnum';
import { PlatType } from '../../../commont/AccountEnum';
import { VideoPubService } from './video/service';
import { ImgTextPubService } from './imgText/service';
import { VideoModel } from '../../db/models/video';
import { ImgTextModel } from '../../db/models/imgText';
import { DmReplyRecordModel } from '../../db/models/dmReplyRecord';
import { ReplyCommentRecordModel } from '../../db/models/replyCommentRecord';
import platController from '../plat';
import { AccountModel } from '../../db/models/account';
import { AccountService } from '../account/service';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type {
  IGetLocationDataParams,
  IGetUsersParams,
} from '../plat/plat.type';
import { douyinService } from '../../plat/douyin';
import { checkXhsCreatorSession } from '../plat/xhsCreatorPublisher';
import { getKernelRuntime } from '../zhiyin-kernel-host';

const BACKEND_BASE = getBackendBase()

/** 从小红书作品链接提取 noteId（/explore/{id} 或 /discovery/item/{id}） */
function extractNoteIdFromLink(link?: string): string {
  if (!link) return ''
  const match = /(?:explore|discovery\/item)\/([0-9a-f]{24})/.exec(link)
  return match ? match[1] : ''
}

/** 向数据统计上报一条发布记录（失败不影响主流程） */
async function reportPublishToBackend(record: {
  dataId: string
  uniqueId?: string
  title?: string
  desc?: string
  coverUrl?: string
  workLink?: string
  accountType: string
  type?: string
  publishTime?: string
  status?: number
  accountId?: string | number
}): Promise<void> {
  try {
    const token = getUserToken()
    if (!token) {
      return
    }
    await fetch(`${BACKEND_BASE}/v2/statistics/desktop/publish-records`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ records: [{
        ...record,
        accountId: record.accountId != null ? String(record.accountId) : undefined,
      }] }),
      signal: AbortSignal.timeout(15000),
    })
  }
  catch {
    // 上报失败不影响发布主流程
  }
}

/** AI 发布成功后回写「内容创作-生成记录」（失败不影响发布主流程） */
async function reportPublishToContentRecord(record: {
  title: string
  description?: string
  imageUrls?: string[]
  noteLink?: string
  platform?: string
}): Promise<void> {
  try {
    const token = getUserToken()
    if (!token) return
    await fetch('http://127.0.0.1:3010/ai/draft-generation/import-record', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(15000),
    })
  }
  catch {
    // 回写失败不影响发布主流程
  }
}

@Controller()
export class PublishController {
  @Inject(PublishService)
  private readonly publishService!: PublishService;

  @Inject(VideoPubService)
  private readonly videoPubService!: VideoPubService;

  @Inject(ImgTextPubService)
  private readonly imgTextPubService!: ImgTextPubService;

  @Inject(AccountService)
  private readonly accountService!: AccountService;

  /**
   * 桌面端直连发布：下载素材到本地 → 建发布记录 → 调平台自动化接口发布
   * 适用于本地账号（个人账号直连），不依赖后端渠道账号体系。
   */
  @Icp('ICP_PUBLISH_DESKTOP_FLOW')
  async desktopPublishFlow(
    event: Electron.IpcMainInvokeEvent,
    payload: {
      items: Array<{
        accountId: number
        type: 'video' | 'image'
        platform: PlatType
        mediaUrls: string[]
        coverUrl?: string
        title?: string
        desc?: string
        topics?: string[]
      }>
    },
  ): Promise<any[]> {
    const userInfo = getUserInfo()
    const results: any[] = []
    const rules = this.loadPlatformRules()

    for (const item of payload.items) {
      try {
        // 发布前会话校验：会话过期时立刻给出明确错误（透传 UI），
        // 不再静默下载素材后等平台超时；全程不弹任何窗口
        if (item.platform === PlatType.Xhs) {
          if (item.type === 'image') {
            await checkXhsCreatorSession();
          } else {
            const acct = await this.accountService.getAccountsByIds([item.accountId]);
            const login = acct[0] && await platController.platLoginCheck(PlatType.Xhs, acct[0]).catch(() => ({ online: false }));
            if (!login?.online) {
              throw new Error('小红书会话已过期，请到「账号管理」重新登录后再发布');
            }
          }
        }
        const rule = rules?.[item.platform] as Record<string, unknown> | undefined
        // AI 依据知识库《平台发布特性与规则》自动校验/修正发布参数
        const normalized = this.applyPlatformRules(item, rule)
        if (rule) {
          logger.info('[desktop-publish] 应用平台发布规则:', item.platform, JSON.stringify(rule))
        }
        if (normalized !== item) {
          logger.info('[desktop-publish] 按规则修正参数:', item.platform, JSON.stringify({
            title: item.title !== normalized.title,
            topics: (item.topics || []).length !== (normalized.topics || []).length,
            mediaCount: item.mediaUrls.length !== normalized.mediaUrls.length,
          }))
        }

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiyin-publish-'))
        // 按 URL 推断扩展名：webp/png 等按实际格式落盘，避免平台按扩展名解析出错
        const inferExt = (url: string, fallback: string) => {
          const match = /\/([a-zA-Z0-9]+)\.(webp|png|jpe?g|gif|mp4|mov)(\?|$)/i.exec(url)
          return match ? `.${match[2].toLowerCase()}` : fallback
        }
        const mediaPaths: string[] = []
        for (let i = 0; i < normalized.mediaUrls.length; i++) {
          const ext = inferExt(normalized.mediaUrls[i], normalized.type === 'video' ? '.mp4' : '.jpg')
          mediaPaths.push(await this.downloadToFile(normalized.mediaUrls[i], path.join(tmpDir, `media-${i}${ext}`)))
        }

        let coverPath: string | undefined
        if (normalized.coverUrl) {
          coverPath = await this.downloadToFile(normalized.coverUrl, path.join(tmpDir, `cover${inferExt(normalized.coverUrl, '.jpg')}`))
        }

        const pubRecord = await this.publishService.createPubRecord({
          id: undefined as unknown as number,
          userId: userInfo.id,
          type: normalized.type === 'video' ? PubType.VIDEO : PubType.ImageText,
          title: normalized.title || '',
          desc: normalized.desc || '',
          coverPath: coverPath || '',
          status: PubStatus.UNPUBLISH,
          publishTime: new Date(),
        })

        const accountId = normalized.accountId
        // 内核优先：小红书发布走内核 CDP 页面驱动（官方插件已停用，插件路径不再可用）
        if (normalized.platform === PlatType.Xhs) {
          const kernel = getKernelRuntime()
          if (kernel) {
            const res = (await kernel.invoke('content.publish', {
              platform: 'xhs',
              accountId,
              title: normalized.title || '',
              desc: normalized.desc || '',
              mediaType: normalized.type === 'video' ? 'video' : 'image',
              mediaPath: mediaPaths[0],
              mediaPaths: normalized.type === 'image' ? mediaPaths : undefined,
            })) as { ok?: boolean; error?: string; data?: unknown }
            if (res?.ok) {
              await this.updatePubRecordStatus(pubRecord.id, [{ code: 1 }])
              const payload = (res.data ?? {}) as { shareLink?: string; results?: { shareLink?: string; noteId?: string } }
              const link = payload.shareLink || payload.results?.shareLink
              const noteId = payload.results?.noteId || extractNoteIdFromLink(link)
              await reportPublishToBackend({
                dataId: noteId,
                uniqueId: noteId ? `xhs_${noteId}` : `xhs_${accountId}_${Date.now()}`,
                title: normalized.title || '',
                desc: normalized.desc || '',
                workLink: link,
                accountType: 'xhs',
                type: normalized.type,
                publishTime: new Date().toISOString(),
                status: 1,
                accountId,
              })
              // 打通「内容创作-生成记录」：AI 发布成功也进入内容创作页，不再各玩各的
              await reportPublishToContentRecord({
                title: normalized.title || '',
                description: normalized.desc || '',
                imageUrls: normalized.mediaUrls ?? [],
                noteLink: link,
                platform: 'xhs',
              })
              results.push({ code: 1, msg: '发布成功', shareLink: link, data: res.data })
              logger.info('[desktop-publish] 内核 CDP 发布成功:', normalized.title, link || '')
              continue
            }
            throw new Error(res?.error || '内核发布失败')
          }
        }
        if (normalized.type === 'video') {
          await this.videoPubService.newVideoPul({
            userId: userInfo.id,
            pubRecordId: pubRecord.id,
            accountId,
            type: normalized.platform,
            videoPath: mediaPaths[0],
            coverPath,
            title: normalized.title || '',
            desc: normalized.desc || '',
            topics: normalized.topics || [],
            status: PubStatus.UNPUBLISH,
            visibleType: 1,
            mentionedUserInfo: [],
          })
          const videoList = await this.videoPubService.getVideoPulListByPubRecordId(pubRecord.id)
          const accountList = await this.accountService.getAccountsByIds([accountId])
          const pubRes = await platController.videoPublish(videoList, accountList)
          await this.updatePubRecordStatus(pubRecord.id, pubRes)
          results.push(pubRes[0] || { code: 0, msg: '发布失败' })
          if (pubRes[0]?.code === 1) {
            // 按实际发布平台上报，避免小红书/视频号作品在数据统计里被标成抖音
            const platformKey = normalized.platform || 'douyin'
            await reportPublishToBackend({
              dataId: String(pubRes[0].dataId || ''),
              uniqueId: `${platformKey}_${pubRes[0].dataId || ''}`,
              title: normalized.title || '',
              desc: normalized.desc || '',
              workLink: pubRes[0].previewVideoLink,
              accountType: platformKey,
              type: 'video',
              publishTime: new Date().toISOString(),
              status: 1,
              accountId,
            })
          }
        }
        else {
          await this.imgTextPubService.createImgTextPul({
            userId: userInfo.id,
            pubRecordId: pubRecord.id,
            accountId,
            type: normalized.platform,
            imagesPath: mediaPaths,
            coverPath,
            title: normalized.title || '',
            desc: normalized.desc || '',
            topics: normalized.topics || [],
            status: PubStatus.UNPUBLISH,
            visibleType: 1,
            mentionedUserInfo: [],
          })
          const imgTextModels = await this.imgTextPubService.getImgTextPulListByPubRecordId(pubRecord.id)
          const accountList = await this.accountService.getAccountsByIds([accountId])
          const pubRes = await platController.imgTextPublish(imgTextModels, accountList)
          await this.updatePubRecordStatus(pubRecord.id, pubRes)
          results.push(pubRes[0] || { code: 0, msg: '发布失败' })
          if (pubRes[0]?.code === 1) {
            // 按实际发布平台上报，避免小红书/视频号作品在数据统计里被标成抖音
            const platformKey = normalized.platform || 'douyin'
            await reportPublishToBackend({
              dataId: String(pubRes[0].dataId || ''),
              uniqueId: `${platformKey}_${pubRes[0].dataId || ''}`,
              title: normalized.title || '',
              desc: normalized.desc || '',
              workLink: pubRes[0].previewVideoLink,
              accountType: platformKey,
              type: 'image',
              publishTime: new Date().toISOString(),
              status: 1,
              accountId,
            })
          }
        }
      }
      catch (error) {
        logger.error('[desktop-publish] item failed:', error)
        results.push({
          code: 0,
          msg: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return results
  }

  /** 回填历史发布记录到数据统计（启动/发布时调用） */
  @Icp('ICP_PUBLISH_SYNC_RECORDS')
  async syncPublishRecordsToBackend(): Promise<{ ingested: number, skipped: number }> {
    try {
      const userInfo = getUserInfo()
      const token = getUserToken()
      const videoRepo = AppDataSource.getRepository(VideoModel)
      const imgTextRepo = AppDataSource.getRepository(ImgTextModel)
      if (!userInfo?.id || !token) {
        return { ingested: 0, skipped: 0 }
      }
      // 只上报当前仍绑定账号的平台数据：账号退出/删除后残留的本地作品/接待记录
      // 不得再进入数据概览（否则会出现「账号管理无该平台账号，概览却有该平台数据」）
      const boundAccounts = await this.accountService.getAccounts()
      const boundTypes = new Set<string>((boundAccounts || []).map((a) => a.type))
      const boundIds = new Set<number>((boundAccounts || []).map((a) => a.id))
      // 依次采集 douyin/xhs/wxSph 三平台作品管理页真实互动数据（回填本地作品表），再上报后端统计
      const platformModules = [
        { type: 'douyin', load: async () => (await import('../plat/platforms/douyin')).default },
        { type: 'xhs', load: async () => (await import('../plat/platforms/xhs')).default },
      ]
      for (const platform of platformModules) {
        // 未绑定该平台账号：不采集、不上报（历史残留数据禁止进入统计）
        if (!boundTypes.has(platform.type)) {
          continue
        }
        try {
          const service = await platform.load()
          const sync = await service.syncWorkStats()
          if (sync.updated > 0) {
            logger.info('[publish] 已采集作品互动数据:', sync.updated, '/', sync.total)
          }
          // 平台全部作品进入发布记录（含用户手动发布、未在本地上报过的作品）
          if (sync.stats?.length) {
            // knownIds 只收集本地作品表已有记录：平台作品不在本地表即视为需补录
            const knownIds = new Set<string>()
            const existing = await videoRepo.find({ where: { userId: userInfo.id } })
            for (const v of existing) {
              if (v.dataId) knownIds.add(v.dataId)
            }
            const imgExisting = await imgTextRepo.find({ where: { userId: userInfo.id } })
            for (const v of imgExisting) {
              if (v.dataId) knownIds.add(v.dataId)
            }
            // 不在本地表但平台真实存在的作品：直接补进后端发布记录（平台采集标记）
            const platformAccountId = boundAccounts.find((a) => a.type === platform.type)?.id
            const extraRecords = sync.stats
              .filter(item => item.dataId && !knownIds.has(item.dataId))
              .map(item => ({
                dataId: item.dataId!,
                uniqueId: `${platform.type}_${item.dataId}`,
                title: item.title || '',
                accountType: platform.type,
                accountId: platformAccountId != null ? String(platformAccountId) : undefined,
                // 后端 PublishRecord.type 枚举仅 video|article（无 image），图文统一按 video 记录
                type: 'video',
                coverUrl: (item as any).coverUrl || '',
                // 小红书作品链接：explore 详情页地址（受限笔记在 Web 端可能无法预览）
                workLink: platform.type === 'xhs' ? `https://www.xiaohongshu.com/explore/${item.dataId}` : undefined,
                publishTime: item.createTime ? new Date(item.createTime * 1000).toISOString() : undefined,
                status: 1,
                viewCount: item.viewCount,
                likeCount: item.likeCount,
                commentCount: item.commentCount,
                shareCount: item.shareCount,
                collectCount: item.collectCount,
              }))
            if (extraRecords.length > 0) {
              logger.info('[publish] 补充平台作品到发布记录:', extraRecords.length)
              await fetch(`${BACKEND_BASE}/v2/statistics/desktop/publish-records`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ records: extraRecords }),
                signal: AbortSignal.timeout(20000),
              })
            }
          }
        } catch (e) {
          logger.error('[publish] 采集作品互动数据失败（不影响记录同步）:', e)
        }
      }
      const videos = await videoRepo.find({ where: { userId: userInfo.id } })
      const records: Array<{
        dataId: string
        uniqueId: string
        title?: string
        desc?: string
        workLink?: string
        accountType: string
        accountId?: string
        type: string
        publishTime?: string
        status?: number
        viewCount?: number
        likeCount?: number
        commentCount?: number
        shareCount?: number
        collectCount?: number
      }> = []
      for (const video of videos) {
        if (!video.dataId) {
          continue
        }
        // 平台账号已解绑的残留作品不上报
        if (!boundTypes.has(video.type)) {
          continue
        }
        records.push({
          dataId: video.dataId,
          uniqueId: `${video.type}_${video.dataId}`,
          title: video.title,
          desc: video.desc,
          workLink: video.previewVideoLink,
          accountType: video.type,
          accountId: video.accountId != null ? String(video.accountId) : undefined,
          type: 'video',
          publishTime: video.publishTime?.toISOString(),
          status: video.status === 1 ? 1 : undefined,
          viewCount: video.readCount,
          likeCount: video.likeCount,
          commentCount: video.commentCount,
          shareCount: video.forwardCount,
          collectCount: video.collectCount,
        })
      }

      const imgTexts = await imgTextRepo.find({ where: { userId: userInfo.id } })
      for (const imgText of imgTexts) {
        if (!imgText.dataId) {
          continue
        }
        // 平台账号已解绑的残留作品不上报
        if (!boundTypes.has(imgText.type)) {
          continue
        }
        records.push({
          dataId: imgText.dataId,
          uniqueId: `${imgText.type}_${imgText.dataId}`,
          title: imgText.title,
          desc: imgText.desc,
          workLink: imgText.previewVideoLink,
          accountType: imgText.type,
          accountId: imgText.accountId != null ? String(imgText.accountId) : undefined,
          type: 'video',
          publishTime: imgText.publishTime?.toISOString(),
          status: imgText.status === 1 ? 1 : undefined,
          viewCount: imgText.readCount,
          likeCount: imgText.likeCount,
          commentCount: imgText.commentCount,
          shareCount: imgText.forwardCount,
          collectCount: imgText.collectCount,
        })
      }

      if (records.length === 0) {
        // 仍同步评论记录
        await this.syncCommentRecords(token, userInfo.id)
        return { ingested: 0, skipped: 0 }
      }

      const res = await fetch(`${BACKEND_BASE}/v2/statistics/desktop/publish-records`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ records }),
        signal: AbortSignal.timeout(20000),
      })
      await this.syncCommentRecords(token, userInfo.id)
      await this.syncDmRecords(token, userInfo.id)
      return await res.json()
    }
    catch (error) {
      logger.error('[publish] 回填发布记录失败:', error)
      return { ingested: 0, skipped: 0 }
    }
  }

  /** 回填私信接待记录（统一进入互动统计，评论+私信口径一致） */
  private async syncDmRecords(token: string, userId: string): Promise<void> {
    try {
      const dmRepo = AppDataSource.getRepository(DmReplyRecordModel)
      const boundAccounts = await this.accountService.getAccounts()
      const boundIds = new Set<number>((boundAccounts || []).map((a) => a.id))
      const records = await dmRepo.find({ where: { userId } })
      // 账号已解绑的私信历史不上报（避免概览出现无绑定平台的接待数据）
      const payload = records
        .filter((record) => boundIds.has(record.accountId))
        .map(record => ({
        workId: '',
        commentId: `dm_${record.id}`,
        content: record.message,
        reply: record.reply,
        nickname: record.senderName || '访客',
        createdAt: record.createTime?.toISOString(),
        type: 'dm',
      }))
      if (payload.length === 0) {
        return
      }
      await fetch(`${BACKEND_BASE}/v2/statistics/desktop/comment-records`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ comments: payload }),
        signal: AbortSignal.timeout(20000),
      })
    }
    catch (error) {
      logger.error('[publish] 回填私信记录失败:', error)
    }
  }

  /** 回填评论记录（作品ID关联，供评论搜索） */
  private async syncCommentRecords(token: string, userId: string): Promise<void> {
    try {
      const commentRepo = AppDataSource.getRepository(ReplyCommentRecordModel)
      const boundAccounts = await this.accountService.getAccounts()
      const boundIds = new Set<number>((boundAccounts || []).map((a) => a.id))
      const comments = await commentRepo.find({ where: { userId } })
      // 账号已解绑的评论历史不上报
      const payload = comments
        .filter((comment) => boundIds.has(comment.accountId))
        .map(comment => ({
          workId: comment.workId ?? '',
          commentId: String(comment.id),
          content: comment.commentContent,
          reply: comment.replyContent,
          nickname: '访客',
          createdAt: comment.createTime?.toISOString(),
        }))
      if (payload.length === 0) {
        return
      }
      await fetch(`${BACKEND_BASE}/v2/statistics/desktop/comment-records`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ comments: payload }),
        signal: AbortSignal.timeout(20000),
      })
    }
    catch (error) {
      logger.error('[publish] 回填评论记录失败:', error)
    }
  }

  /** 读取知识库内置发布规则（持续更新：修改知识库 JSON 即生效） */
  private loadPlatformRules(): Record<string, Record<string, unknown>> {
    const candidates = [
      path.join(app.getPath('userData'), '知音知识库', '06-平台发布规则.json'),
      path.join(app.getAppPath(), 'resources', 'knowledge-seed', '06-平台发布规则.json'),
    ]
    for (const file of candidates) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, Record<string, unknown>>
        if (parsed && typeof parsed === 'object') {
          return parsed
        }
      }
      catch {
        // 尝试下一个候选路径
      }
    }
    return {}
  }

  /** 依据平台规则自动修正发布参数（标题长度/话题数/图片数） */
  private applyPlatformRules(
    item: {
      accountId: number
      type: 'video' | 'image'
      platform: PlatType
      title?: string
      desc?: string
      topics?: string[]
      mediaUrls: string[]
      coverUrl?: string
    },
    rule?: Record<string, unknown>,
  ) {
    if (!rule) {
      return item
    }
    const next = { ...item }
    if (typeof rule.titleMax === 'number' && next.title) {
      next.title = next.title.slice(0, rule.titleMax)
    }
    if (typeof rule.topicsMax === 'number' && next.topics) {
      next.topics = next.topics.slice(0, rule.topicsMax)
    }
    if (typeof rule.imagesMax === 'number' && next.mediaUrls.length > rule.imagesMax) {
      next.mediaUrls = next.mediaUrls.slice(0, rule.imagesMax)
    }
    return next
  }

  private async downloadToFile(url: string, dest: string): Promise<string> {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`下载素材失败 (${res.status})`)
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(dest, buffer)
    return dest
  }

  private async updatePubRecordStatus(
    pubRecordId: number,
    pubRes: Array<{ code: number }>,
  ): Promise<void> {
    let successCount = 0
    for (const v of pubRes) {
      if (v.code === 1) {
        successCount++
      }
    }
    const status = successCount === 0
      ? PubStatus.FAIL
      : successCount === pubRes.length
        ? PubStatus.RELEASED
        : PubStatus.PartSuccess
    await this.publishService.updatePubRecordStatus(pubRecordId, status)
  }

  // 创建发布记录
  @Icp('ICP_PUBLISH_CREATE_PUB_RECORD')
  async createPubRecord(
    event: Electron.IpcMainInvokeEvent,
    pubRecord: PubRecordModel,
  ): Promise<any> {
    pubRecord.userId = getUserInfo().id;
    pubRecord.publishTime = new Date();
    return await this.publishService.createPubRecord(pubRecord);
  }

  // 获取发布记录列表
  @Icp('ICP_PUBLISH_GET_PUB_RECORD_LIST')
  async getPubRecordList(
    event: Electron.IpcMainInvokeEvent,
    page: CorrectQuery,
    query?: pubRecordListQuery,
  ): Promise<any> {
    const userInfo = getUserInfo();
    const filters: FindOptionsWhere<PubRecordModel> = !query
      ? {}
      : {
          ...(query.type !== undefined && { type: query.type }),
          ...(query.status === undefined
            ? {}
            : {
                status: query.status,
              }),
          ...(query.time !== undefined &&
            query.time.length === 2 &&
            Between(new Date(query.time[0]), new Date(query.time[1]))),
        };
    return await this.publishService.getPubRecordList(
      userInfo.id,
      page,
      filters,
    );
  }

  // 获取草稿列表
  @Icp('ICP_PUBLISH_GET_PUB_RECORD_DRAFTS_LIST')
  async getPubRecordDraftsList(
    event: Electron.IpcMainInvokeEvent,
    page: CorrectQuery,
    query?: {
      time?: [string, string];
      type?: PubType;
    },
  ): Promise<any> {
    const userInfo = getUserInfo();
    const filters: FindOptionsWhere<PubRecordModel> = !query
      ? {
          status: PubStatus.UNPUBLISH,
        }
      : {
          status: PubStatus.UNPUBLISH,
          ...(query.type !== undefined && { type: query.type }),
          ...(query.time !== undefined &&
            query.time.length === 2 &&
            Between(new Date(query.time[0]), new Date(query.time[1]))),
        };
    return await this.publishService.getPubRecordList(
      userInfo.id,
      page,
      filters,
    );
  }

  // 获取发布记录的发布内容列表
  @Icp('ICP_PUBLISH_GET_PUB_RECORD_ITEM_LIST')
  async getPubRecordItemList(
    event: Electron.IpcMainInvokeEvent,
    page: CorrectQuery,
    id: number,
  ): Promise<any> {
    let res = backPageData<VideoModel | ImgTextModel | never>([], 0, page);
    const pubRecordInfo = await this.publishService.getPubRecordInfo(id);
    if (!pubRecordInfo) return res;

    if (pubRecordInfo.type === PubType.VIDEO) {
      res = await this.videoPubService.getVideoPulListByPubRecordIdToShow(
        id,
        page,
      );
    } else if (pubRecordInfo.type === PubType.ARTICLE) {
      res = await this.imgTextPubService.getImgTextPulListByPubRecordIdToShow(
        id,
        page,
      );
    }

    return res;
  }

  // 获取发布记录信息
  @Icp('ICP_PUBLISH_GET_PUB_RECORD_INFO')
  async getPubRecordInfo(
    event: Electron.IpcMainInvokeEvent,
    id: number,
  ): Promise<any> {
    return await this.publishService.getPubRecordInfo(id);
  }

  // 删除发布记录
  @Icp('ICP_PUBLISH_DEL_PUB_RECORD_BY_ID')
  async delPubRecord(event: Electron.IpcMainInvokeEvent, id: number) {
    return await this.publishService.deletePubRecordById(id);
  }

  // 获取所有平台话题
  @Icp('ICP_PUBLISH_GET_TOPIC')
  async getTopic(
    event: Electron.IpcMainInvokeEvent,
    account: AccountModel,
    keyword: string,
  ) {
    return await platController.getTopic(account, keyword);
  }

  // 获取所有平台位置数据
  @Icp('ICP_PUBLISH_GET_LOCATION')
  async getLocationData(
    event: Electron.IpcMainInvokeEvent,
    params: IGetLocationDataParams,
  ) {
    return await platController.getLocationData(params);
  }

  // 获取所有平台合集数据
  @Icp('ICP_PUBLISH_GET_MIX_LIST')
  async getMixList(event: Electron.IpcMainInvokeEvent, account: AccountModel) {
    return await platController.getMixList(account);
  }

  // 获取所有平台的用户数据
  @Icp('ICP_PUBLISH_GET_USERS')
  async getUsers(event: Electron.IpcMainInvokeEvent, params: IGetUsersParams) {
    return await platController.getUsers(params);
  }

  // 获取抖音热点数据
  @Icp('ICP_PUBLISH_GET_DOYTIN_HOT')
  async getDoytinHot(
    event: Electron.IpcMainInvokeEvent,
    account: AccountModel,
    query: string,
  ) {
    const res = await douyinService.getHotspotData({
      query: query,
      cookie: JSON.parse(account.loginCookie),
    });
    return res.data;
  }

  // 获取抖音所有热点数据
  @Icp('ICP_PUBLISH_GET_ALL_DOYTIN_HOT')
  async getDoytinHotAll(event: Electron.IpcMainInvokeEvent) {
    const res = await douyinService.getAllHotspotData();
    return res.data;
  }

  // 获取抖音的活动列表
  @Icp('ICP_PUBLISH_GET_DOUYIN_ACTIVITY')
  async getDouyinActivity(
    event: Electron.IpcMainInvokeEvent,
    account: AccountModel,
  ) {
    const res = await douyinService.getActivity(
      JSON.parse(account.loginCookie),
    );
    return res.data;
  }

  // 获取抖音的活动详情
  @Icp('ICP_PUBLISH_GET_DOUYIN_ACTIVITY_DETAILS')
  async getDouyinActivityDetails(
    event: Electron.IpcMainInvokeEvent,
    account: AccountModel,
    activity_id: string,
  ) {
    const res = await douyinService.getActivityDetails(
      JSON.parse(account.loginCookie),
      activity_id,
    );
    return res.data;
  }

  // 获取抖音活动标签
  @Icp('ICP_PUBLISH_GET_DOUYIN_ACTIVITY_TAGS')
  async getActivityTags(
    event: Electron.IpcMainInvokeEvent,
    account: AccountModel,
  ) {
    return await douyinService.getActivityTags(JSON.parse(account.loginCookie));
  }

}
