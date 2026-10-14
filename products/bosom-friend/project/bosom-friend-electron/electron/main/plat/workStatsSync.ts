/**
 * 作品数据自动同步器（多平台采集器注册表）
 *
 * 7×24 自动维护数据概览的真实性：按注册的采集器逐平台采集作品管理页真实互动数据，
 * 回填本地作品表并上报后端统计，无需人工触发。
 * 会话失效时跳过（由用户手动登录恢复，后台绝不弹窗）。
 */
import { AppDataSource } from '../../db';
import { AccountModel } from '../../db/models/account';
import { ImgTextModel } from '../../db/models/imgText';
import { VideoModel } from '../../db/models/video';
import { PlatType } from '../../../commont/AccountEnum';
import { logger } from '../../global/log';
import { appendAutoLog } from '../knowledge/autoLog';
import { container } from '../core/container';
// [slim] 遥测已随精简移除：操作指标埋点降级为空实现（保持可 await/.catch 的原调用形态）
const logOperationMetrics = async (): Promise<void> => {};
import douyin from './platforms/douyin';
import xhs from './platforms/xhs';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_SYNC_DELAY_MS = 20 * 1000;
/** 采集冷却窗口：5 分钟内同一平台不重复触发 CDP 导航 */
const COLLECT_COOLDOWN_MS = 5 * 60 * 1000;

/** 各平台最近一次 CDP 采集时间戳（周期同步与发布回填共享的冷却表） */
const collectCooldown = new Map<PlatType, number>();

/**
 * 尝试占用平台的采集冷却槽：未在冷却期则记录时间并返回 true，否则返回 false。
 * 调用方仅在返回 true 时才执行 CDP 采集，避免周期同步与发布回填同轮重复导航。
 */
export function tryClaimCollectSlot(platform: PlatType): boolean {
  const now = Date.now();
  const last = collectCooldown.get(platform);
  if (last != null && now - last < COLLECT_COOLDOWN_MS) {
    return false;
  }
  collectCooldown.set(platform, now);
  return true;
}

/** 平台作品互动数据采集器：采集真实数据并回填本地作品表 */
export interface WorkStatsCollector {
  platform: PlatType;
  /** 采集平台真实作品互动数据，返回 { updated: 已更新作品数, total: 平台作品总数 } */
  collect: () => Promise<{ updated: number; total: number }>;
  /** 刷新账号概要（粉丝数/作品数），可选 */
  refreshAccountSummary?: (account: AccountModel) => Promise<void>;
}

/**
 * 采集器注册表：新增平台采集时在此注册（小红书/视频号采集驱动接入后追加）。
 */
export const workStatsCollectors: WorkStatsCollector[] = [
  {
    platform: PlatType.Douyin,
    collect: () => douyin.syncWorkStats(),
    refreshAccountSummary: (account: AccountModel) =>
      refreshDouyinAccountSummary(account),
  },
  {
    platform: PlatType.Xhs,
    // 小红书采集依赖已登录的创作者窗口；未登录时驱动优雅返回空
    collect: () => (xhs as { syncWorkStats: () => Promise<{ updated: number, total: number }> }).syncWorkStats(),
    refreshAccountSummary: (account: AccountModel) => refreshXhsAccountSummary(account),
  },
];

class WorkStatsSync {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private syncing = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.syncOnce(), SYNC_INTERVAL_MS);
    setTimeout(() => void this.syncOnce(), FIRST_SYNC_DELAY_MS);
    logger.log('[work-stats-sync] 作品互动数据自动同步已启动（每 10 分钟）');
  }

  /** 单次同步：逐采集器采集 → 回填本地 → 上报后端 */
  async syncOnce(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const repo = AppDataSource.getRepository(AccountModel);

      for (const collector of workStatsCollectors) {
        await this.syncPlatform(collector, repo);
      }

      // 每轮同步后输出运营指标（发布成功率/账号健康/采集覆盖率）
      await logOperationMetrics().catch(() => {});
    } catch (e) {
      logger.error('[work-stats-sync] 自动同步失败:', e);
    } finally {
      this.syncing = false;
    }
  }

  /** 单平台采集：会话有效才采集；采集到数据后回填账号概要并上报后端 */
  private async syncPlatform(
    collector: WorkStatsCollector,
    repo: ReturnType<typeof AppDataSource.getRepository<AccountModel>>,
  ): Promise<void> {
    try {
      const account = await repo.findOne({
        where: { type: collector.platform as any },
      });
      if (!account?.loginCookie) {
        return;
      }

      // 采集冷却：5 分钟内同一平台不重复触发 CDP 导航（周期同步与发布回填共享）
      if (!tryClaimCollectSlot(collector.platform)) {
        logger.info(`[work-stats-sync] ${collector.platform} 处于采集冷却期，跳过本轮 CDP 采集`);
        return;
      }

      // 直接尝试采集：页面会话有效则成功，失效时驱动返回 0（无副作用，看门狗负责弹窗扫码）
      const result = await collector.collect();

      // 顺带刷新账号真实粉丝数/作品数（数据概览账号卡片使用）
      if (collector.refreshAccountSummary) {
        try {
          await collector.refreshAccountSummary(account);
        }
        catch (e) {
          logger.error('[work-stats-sync] 刷新账号粉丝/作品数失败:', e);
        }
      }

      if (result.updated > 0) {
        await appendAutoLog(
          '数据同步',
          `自动采集作品互动数据 ${collector.platform} ${result.updated}/${result.total} 个作品`,
        );
        // 上报后端统计（发布记录带最新互动数据）
        try {
          const publishController = container.getController('PublishController') as {
            syncPublishRecordsToBackend: () => Promise<{ ingested: number; skipped: number }>;
          };
          if (publishController?.syncPublishRecordsToBackend) {
            await publishController.syncPublishRecordsToBackend();
          }
        } catch (e) {
          logger.error('[work-stats-sync] 上报互动数据失败:', e);
        }
      }
    }
    catch (e) {
      logger.error('[work-stats-sync] 平台采集失败:', collector.platform, e);
    }
  }
}

/**
 * 刷新抖音账号卡片概要数据：粉丝数取平台真实 API，作品数取本地作品表真实行数。
 */
async function refreshDouyinAccountSummary(account: AccountModel): Promise<void> {
  const videoRepo = AppDataSource.getRepository(VideoModel);
  const imgTextRepo = AppDataSource.getRepository(ImgTextModel);
  const videoCount = await videoRepo.count({ where: { userId: account.userId } });
  const imgTextCount = await imgTextRepo.count({ where: { userId: account.userId } });
  const nextWorkCount = videoCount + imgTextCount;

  let nextFansCount: number | null = null;
  try {
    const stats = await douyin.getStatistics(account);
    nextFansCount = stats.fansCount ?? null;
  }
  catch (e) {
    logger.warn('[work-stats-sync] 拉取粉丝数失败（保留旧值）:', e);
  }

  const patch: Partial<AccountModel> = { workCount: nextWorkCount };
  if (nextFansCount != null) {
    patch.fansCount = nextFansCount;
  }
  const repo = AppDataSource.getRepository(AccountModel);
  await repo.update({ id: account.id }, patch);
}

/**
 * 刷新小红书账号卡片概要数据：粉丝数取平台真实 API（会话失效时降级），作品数取本地真实行数。
 */
async function refreshXhsAccountSummary(account: AccountModel): Promise<void> {
  const stats = await xhs.getStatistics(account);
  await persistAccountSummary(account, stats);
}

/** 回填账号卡片概要：粉丝数与作品数写回 AccountModel（粉丝数缺失时保留旧值） */
async function persistAccountSummary(
  account: AccountModel,
  summary: { fansCount?: number | null; workCount: number },
): Promise<void> {
  const repo = AppDataSource.getRepository(AccountModel);
  const patch: Partial<AccountModel> = { workCount: summary.workCount };
  if (summary.fansCount != null) {
    patch.fansCount = summary.fansCount;
  }
  await repo.update({ id: account.id }, patch);
}

export const workStatsSync = new WorkStatsSync();
