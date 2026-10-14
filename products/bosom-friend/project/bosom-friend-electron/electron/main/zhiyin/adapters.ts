/**
 * 知音内核 · 平台传输适配器
 *
 * 这里是“摸着安卓过河”的边界：旧客户端驱动的能力只以适配器身份
 * 出现在本文件，内核（project/zhiyin-harness）保持零旧代码依赖。
 */
import { AppDataSource } from '../../db';
import { AccountModel } from '../../db/models/account';
import { VideoModel } from '../../db/models/video';
import { ImgTextModel } from '../../db/models/imgText';
import { PubRecordModel } from '../../db/models/pubRecord';
import { ReplyCommentRecordModel } from '../../db/models/replyCommentRecord';
import { DmReplyRecordModel } from '../../db/models/dmReplyRecord';
import { AccountStatus, PlatType } from '../../../commont/AccountEnum';
import { PubStatus, PubType } from '../../../commont/publish/PublishEnum';
import { logger } from '../../global/log';
import { riskManager } from '../safety/riskManager';
import { quotaManager } from '../safety/quotaManager';
import { getUserInfo, getUserToken } from '../user/comment';
import { getBackendBase } from '../config/backendBase';
import { container } from '../core/container';
import platController from '../plat';
import { collectDouyinWorkStats } from '../plat/platforms/douyin/douyinWorkPageDriver';
import { collectXhsWorkStats } from '../plat/platforms/xhs/xhsWorkPageDriver';
import { replyCommentsViaPage } from '../reply/commentPageDriver';
import { sendDmViaPage } from '../dm/douyinImPageDriver';
import { sendXhsChatMessage } from '../plat/xhsImSender';
import {
  publishVideoViaCreator as publishDouyinVideo,
  publishImageNoteViaCreator as publishDouyinImage,
} from '../plat/douyinCreatorPublisher';
import {
  publishImageNoteViaCreator as publishXhsImage,
  publishVideoNoteViaCreator as publishXhsVideo,
} from '../plat/xhsCreatorPublisher';
import type {
  InteractionItem,
  PlatformAccount,
  PlatformAdapter,
  WorkItem,
} from '../../../../bosom-friend-harness/src/index';

interface StatsItem {
  dataId: string;
  title?: string;
  coverUrl?: string;
  createTime?: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  collectCount: number;
}

function toIso(value: number | undefined, isMs: boolean): string | undefined {
  if (!value) return undefined;
  const date = new Date(isMs ? value : value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toWorkItem(
  platform: string,
  accountId: number,
  item: StatsItem,
  isMs = false,
): WorkItem {
  return {
    id: `${platform}-${item.dataId}`,
    dataId: item.dataId,
    kind: 'video',
    platform,
    accountId,
    title: item.title,
    coverUrl: item.coverUrl,
    viewCount: item.viewCount || 0,
    likeCount: item.likeCount || 0,
    commentCount: item.commentCount || 0,
    shareCount: item.shareCount || 0,
    collectCount: item.collectCount || 0,
    publishTime: toIso(item.createTime, isMs),
    status: 'published',
  };
}

async function getAccount(accountId: number): Promise<AccountModel | null> {
  return AppDataSource.getRepository(AccountModel).findOne({
    where: { id: accountId },
  });
}

/** 列出 APP 已登录的指定平台账号（缺省列出全部），供内核 Agent 自主确定 accountId */
async function listAllAccounts(platform?: string): Promise<PlatformAccount[]> {
  const repo = AppDataSource.getRepository(AccountModel);
  const rows = await repo.find({ order: { id: 'ASC' } });
  return rows
    .filter(row => !platform || String(row.type) === platform)
    .map((row) => ({
      accountId: row.id,
      platform: String(row.type),
      nickname: row.nickname || row.account || `账号${row.id}`,
      status: row.status === AccountStatus.DISABLE ? 'expired' : 'usable',
      fansCount: row.fansCount || 0,
    }));
}

function checkRisk(
  platform: string,
  accountId: number,
  operation: 'comment_reply' | 'dm_reply' | 'publish',
): { ok: true } | { ok: false; error: string } {
  const risk = riskManager.canOperate(platform, accountId);
  if (!risk.ok) {
    return { ok: false, error: '账号处于风控冷却期，已自动跳过' };
  }
  const quota = quotaManager.canOperate(platform, accountId, operation);
  if (!quota.ok) {
    return { ok: false, error: `操作被安全配额限制：${quota.reason}` };
  }
  return { ok: true };
}

function reportSuccess(platform: string, accountId: number, operation: 'comment_reply' | 'dm_reply' | 'publish'): void {
  riskManager.reportSuccess(platform, accountId);
  quotaManager.reportOperation(platform, accountId, operation);
}

/**
 * 内核发布完成后，把结果写回 APP 自己的发布记录体系：
 * 发布日历、数据概览与后端统计共用同一份 pubRecord，
 * 保证“平台已发布的内容，APP 里一定有条可见记录”。
 */
async function recordPublishToApp(input: {
  platform: string;
  accountId: number;
  title: string;
  desc?: string;
  mediaType?: 'video' | 'image';
  mediaPath?: string;
  ok: boolean;
  dataId?: string;
  workLink?: string;
}): Promise<void> {
  try {
    const record = new PubRecordModel();
    record.userId = getUserInfo().id;
    record.type = input.mediaType === 'video' ? PubType.VIDEO : PubType.ImageText;
    record.title = input.title || '';
    record.desc = input.desc || '';
    if (input.mediaType === 'video')
      record.videoPath = input.mediaPath;
    record.coverPath = '';
    record.publishTime = new Date();
    record.status = input.ok ? PubStatus.RELEASED : PubStatus.FAIL;
    await AppDataSource.getRepository(PubRecordModel).save(record);
    logger.info(`[adapter] 发布已写入 APP 发布记录：${input.title}（${input.platform}）`);

    const publishController = container.getController('PublishController') as {
      syncPublishRecordsToBackend?: () => Promise<unknown>;
    };
    if (publishController?.syncPublishRecordsToBackend)
      await publishController.syncPublishRecordsToBackend();

    // 发布即上账：带平台作品 ID 直接写入后端发布记录（数据概览/发布日历即刻可见，
    // 不依赖后续周期采集；账号归属一并写入，避免列表按账号过滤后为空）
    if (input.ok && input.dataId) {
      try {
        const token = getUserToken();
        if (token) {
          await fetch(`${getBackendBase()}/v2/statistics/desktop/publish-records`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              records: [{
                dataId: input.dataId,
                uniqueId: `${input.platform}_${input.dataId}`,
                title: input.title || '',
                desc: input.desc || '',
                workLink: input.workLink,
                accountType: input.platform,
                type: 'video',
                publishTime: new Date().toISOString(),
                status: 1,
                accountId: String(input.accountId),
              }],
            }),
            signal: AbortSignal.timeout(15000),
          });
          logger.info(`[adapter] 发布记录已上报后端：${input.title}（${input.platform}/${input.dataId}）`);
        }
      }
      catch (error) {
        logger.warn('[adapter] 上报后端发布记录失败（不影响平台已发布结果）:', error);
      }
    }
  }
  catch (error) {
    logger.warn('[adapter] 写入 APP 发布记录失败（不影响平台已发布结果）:', error);
  }
}

async function dbComments(platform: PlatType): Promise<InteractionItem[]> {
  const repo = AppDataSource.getRepository(ReplyCommentRecordModel);
  const rows = await repo.find({
    where: { type: platform },
    order: { id: 'DESC' },
    take: 50,
  });
  return rows.map((r) => ({
    id: `c${r.id}`,
    kind: 'comment' as const,
    platform: String(r.type),
    accountId: r.accountId,
    sourceId: r.commentId,
    workId: r.workId,
    content: r.commentContent,
    reply: r.replyContent,
    status: 'replied' as const,
  }));
}

async function dbDms(platform: PlatType): Promise<InteractionItem[]> {
  const repo = AppDataSource.getRepository(DmReplyRecordModel);
  const rows = await repo.find({
    where: { type: platform },
    order: { id: 'DESC' },
    take: 50,
  });
  return rows.map((r) => ({
    id: `d${r.id}`,
    kind: 'dm' as const,
    platform: String(r.type),
    accountId: r.accountId,
    sourceId: String(r.id),
    peerName: r.senderName,
    content: r.message,
    reply: r.reply,
    status: r.status === 1 ? ('replied' as const) : ('failed' as const),
  }));
}

async function dbWorks(platform: PlatType): Promise<WorkItem[]> {
  const videoRepo = AppDataSource.getRepository(VideoModel);
  const imgTextRepo = AppDataSource.getRepository(ImgTextModel);
  const [videos, imgTexts] = await Promise.all([
    videoRepo.find({ where: { type: platform }, order: { publishTime: 'DESC' }, take: 100 }),
    imgTextRepo.find({ where: { type: platform }, order: { publishTime: 'DESC' }, take: 100 }),
  ]);
  const map = (m: VideoModel | ImgTextModel, kind: 'video' | 'imgtext'): WorkItem => ({
    id: String(m.id),
    dataId: m.dataId || String(m.id),
    kind,
    platform: String(m.type),
    accountId: m.accountId,
    title: m.title,
    desc: m.desc,
    coverUrl: m.coverPath,
    viewCount: m.readCount || 0,
    likeCount: m.likeCount || 0,
    commentCount: m.commentCount || 0,
    shareCount: m.forwardCount || 0,
    collectCount: m.collectCount || 0,
    publishTime: m.publishTime ? m.publishTime.toISOString() : undefined,
    status: String(m.status ?? ''),
  });
  return [
    ...videos.map((v) => map(v, 'video')),
    ...imgTexts.map((i) => map(i, 'imgtext')),
  ];
}

let douyinWorks: WorkItem[] = [];
let xhsWorks: WorkItem[] = [];

const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',
  listAccounts: (platform?: string) => listAllAccounts(platform),
  async collectWorkStats(accountId) {
    const items = await collectDouyinWorkStats();
    douyinWorks = items.map((s) => toWorkItem('douyin', accountId, s));
    return { updated: items.length, total: items.length };
  },
  async listWorks(accountId) {
    if (!douyinWorks.length) await this.collectWorkStats(accountId);
    return douyinWorks;
  },
  listComments: () => dbComments(PlatType.Douyin),
  listDms: () => dbDms(PlatType.Douyin),
  async replyComment(input) {
    const risk = checkRisk('douyin', input.accountId, 'comment_reply');
    if (!risk.ok) return { ok: false, message: risk.error };
    const batch = await replyCommentsViaPage(input.workId, input.title || '', [
      { commentId: input.commentId, commentText: '', reply: input.content },
    ]);
    const ok = batch.ok && batch.results[0]?.ok === true;
    if (ok) reportSuccess('douyin', input.accountId, 'comment_reply');
    return { ok, message: batch.message || batch.results[0]?.message };
  },
  async replyComments(input) {
    const risk = checkRisk('douyin', input.accountId, 'comment_reply');
    if (!risk.ok) return { ok: false, message: risk.error };
    const batch = await replyCommentsViaPage(
      input.workId,
      input.title || '',
      input.items.map((item) => ({
        commentId: item.commentId,
        commentText: item.commentText || '',
        reply: item.content,
      })),
    );
    if (batch.ok) reportSuccess('douyin', input.accountId, 'comment_reply');
    return {
      ok: batch.ok,
      message: batch.message,
      results: batch.results.map((r) => ({
        commentId: r.commentId,
        ok: r.ok === true,
        message: r.message,
      })),
    };
  },
  async sendDm(input) {
    const risk = checkRisk('douyin', input.accountId, 'dm_reply');
    if (!risk.ok) return { ok: false, message: risk.error };
    const res = await sendDmViaPage(input.peerName, input.content);
    if (res.ok) reportSuccess('douyin', input.accountId, 'dm_reply');
    return { ok: res.ok, message: res.message || res.status };
  },
  async publish(input) {
    const risk = checkRisk('douyin', input.accountId, 'publish');
    if (!risk.ok) return { ok: false, message: risk.error };
    // 防重复发布：同名内容近期已在抖音上线就直接跳过（发布成功回执偶发丢失导致的重复重试保护）
    try {
      if (!douyinWorks.length) await this.collectWorkStats(input.accountId);
      const recent = Date.now() - 2 * 60 * 60 * 1000;
      const titleKey = input.title.trim().slice(0, 12);
      const dup = douyinWorks.find((w) => {
        if (!w.title || w.title.trim().slice(0, 12) !== titleKey) return false;
        const t = w.publishTime ? new Date(w.publishTime).getTime() : 0;
        return t > recent;
      });
      if (dup) {
        return { ok: false, message: `该内容近期已发布到抖音（作品 ${dup.dataId}），已跳过避免重复发布` };
      }
    } catch (error) {
      logger.warn('[douyin-adapter] 发布前去重检查失败，继续发布:', error);
    }
    if (input.mediaType === 'video') {
      if (!input.mediaPath) return { ok: false, message: '缺少视频文件' };
      try {
        const result = await publishDouyinVideo({
          videoPath: input.mediaPath,
          title: input.title,
        });
        reportSuccess('douyin', input.accountId, 'publish');
        void recordPublishToApp({
          platform: 'douyin',
          accountId: input.accountId,
          title: input.title,
          desc: input.desc,
          mediaType: 'video',
          mediaPath: input.mediaPath,
          ok: true,
          dataId: result.videoId,
          workLink: result.shareLink,
        });
        return { ok: true, message: result.shareLink, results: result };
      }
      catch (error) {
        void recordPublishToApp({
          platform: 'douyin',
          accountId: input.accountId,
          title: input.title,
          desc: input.desc,
          mediaType: 'video',
          mediaPath: input.mediaPath,
          ok: false,
        });
        return { ok: false, message: error instanceof Error ? error.message : '抖音视频发布失败' };
      }
    }
    if (input.mediaType === 'image') {
      if (!input.mediaPath) return { ok: false, message: '缺少图片文件' };
      try {
        const result = await publishDouyinImage({
          images: [input.mediaPath],
          title: input.title,
          desc: input.desc,
        });
        reportSuccess('douyin', input.accountId, 'publish');
        void recordPublishToApp({
          platform: 'douyin',
          accountId: input.accountId,
          title: input.title,
          desc: input.desc,
          mediaType: 'image',
          mediaPath: input.mediaPath,
          ok: true,
          dataId: result.videoId,
          workLink: result.shareLink,
        });
        return { ok: true, message: result.shareLink, results: result };
      }
      catch (error) {
        void recordPublishToApp({
          platform: 'douyin',
          accountId: input.accountId,
          title: input.title,
          desc: input.desc,
          mediaType: 'image',
          mediaPath: input.mediaPath,
          ok: false,
        });
        return { ok: false, message: error instanceof Error ? error.message : '抖音图文发布失败' };
      }
    }
    return { ok: false, message: '抖音纯文本发布暂不支持，请配图或配视频' };
  },
};

const xhsAdapter: PlatformAdapter = {
  platform: 'xhs',
  listAccounts: (platform?: string) => listAllAccounts(platform),
  async collectWorkStats(accountId) {
    const items = await collectXhsWorkStats();
    xhsWorks = items.map((s) => toWorkItem('xhs', accountId, s, true));
    return { updated: items.length, total: items.length };
  },
  async listWorks(accountId) {
    if (!xhsWorks.length) await this.collectWorkStats(accountId);
    return xhsWorks;
  },
  listComments: () => dbComments(PlatType.Xhs),
  listDms: () => dbDms(PlatType.Xhs),
  async replyComment(input) {
    const account = await getAccount(input.accountId);
    if (!account) return { ok: false, message: '账号不存在，请先在账号管理登录' };
    const risk = checkRisk('xhs', input.accountId, 'comment_reply');
    if (!risk.ok) return { ok: false, message: risk.error };
    const res = (await platController.replyComment(
      account,
      { dataId: input.workId, title: input.title } as never,
      input.commentId,
      input.content,
      undefined,
    )) as { status?: number; data?: { code?: number; success?: boolean } };
    const ok =
      (res?.status === 200 || res?.status === 201) &&
      res?.data?.code === 0 &&
      res?.data?.success !== false;
    if (ok) reportSuccess('xhs', input.accountId, 'comment_reply');
    return { ok, message: ok ? undefined : JSON.stringify(res?.data || {}) };
  },
  async sendDm(input) {
    const risk = checkRisk('xhs', input.accountId, 'dm_reply');
    if (!risk.ok) return { ok: false, message: risk.error };
    const res = await sendXhsChatMessage(input.peerName, input.content);
    const ok = res?.data?.code === 0 && res?.data?.success !== false;
    if (ok) reportSuccess('xhs', input.accountId, 'dm_reply');
    return { ok, message: res?.data?.msg };
  },
  async publish(input) {
    const risk = checkRisk('xhs', input.accountId, 'publish');
    if (!risk.ok) return { ok: false, message: risk.error };
    if (input.mediaType === 'video') {
      if (!input.mediaPath) return { ok: false, message: '缺少视频文件' };
      try {
        const result = await publishXhsVideo({
          videoPath: input.mediaPath,
          title: input.title,
          desc: input.desc || '',
        });
        reportSuccess('xhs', input.accountId, 'publish');
        void recordPublishToApp({
          platform: 'xhs',
          accountId: input.accountId,
          title: input.title,
          desc: input.desc,
          mediaType: 'video',
          mediaPath: input.mediaPath,
          ok: true,
          dataId: result.noteId,
          workLink: result.shareLink,
        });
        return { ok: true, message: '小红书视频已发布', results: result };
      }
      catch (error) {
        void recordPublishToApp({
          platform: 'xhs',
          accountId: input.accountId,
          title: input.title,
          desc: input.desc,
          mediaType: 'video',
          mediaPath: input.mediaPath,
          ok: false,
        });
        return { ok: false, message: error instanceof Error ? error.message : '小红书视频发布失败' };
      }
    }
    if (input.mediaType === 'image') {
      const paths = input.mediaPaths?.length
        ? input.mediaPaths
        : input.mediaPath
          ? [input.mediaPath]
          : [];
      if (!paths.length) return { ok: false, message: '缺少图片文件' };
      try {
        const result = await publishXhsImage({
          images: paths,
          title: input.title,
          desc: input.desc || '',
        });
        reportSuccess('xhs', input.accountId, 'publish');
        void recordPublishToApp({
          platform: 'xhs',
          accountId: input.accountId,
          title: input.title,
          desc: input.desc,
          mediaType: 'image',
          mediaPath: paths[0],
          ok: true,
          dataId: result.noteId,
          workLink: result.shareLink,
        });
        return { ok: true, message: '小红书图文已发布', results: result };
      }
      catch (error) {
        void recordPublishToApp({
          platform: 'xhs',
          accountId: input.accountId,
          title: input.title,
          desc: input.desc,
          mediaType: 'image',
          mediaPath: paths[0],
          ok: false,
        });
        return { ok: false, message: error instanceof Error ? error.message : '小红书图文发布失败' };
      }
    }
    return { ok: false, message: '小红书纯文本发布暂不支持，请配图或配视频' };
  },
};

export function buildPlatformAdapters(): PlatformAdapter[] {
  return [douyinAdapter, xhsAdapter];
}
