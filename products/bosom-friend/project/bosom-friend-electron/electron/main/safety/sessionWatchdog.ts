/*
 * 会话监视器（纯后台监测，零弹窗）
 *
 * 设计原则（用户硬性要求）：
 * 1. 登录弹窗只允许在用户手动点击登录时出现一次——本模块绝不自动弹任何窗口；
 * 2. 登录会话永久保存，仅用户手动「退出登录」时清理；
 * 3. 数据获取/私信/评论回复全部后台执行，本模块只做状态监测与日志记录。
 *
 * 职责：周期检测各平台会话（浏览器 cookie 判据），失效时更新账号状态为离线，
 * 让界面如实显示「未登录」；不弹窗、不清理会话、不自动重新授权。
 */
import { AppDataSource } from '../../db';
import { AccountModel } from '../../db/models/account';
import { AccountStatus, PlatType } from '../../../commont/AccountEnum';
import { logger } from '../../global/log';
import { isPlatformSessionValid } from '../plat/platformLogin';
import platController from '../plat';

const SCAN_INTERVAL_MS = 3 * 60 * 1000;

class SessionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.scanAll().catch((e) =>
      logger.error('[session-monitor] 启动扫描失败', e),
    );
    this.timer = setInterval(() => {
      void this.scanAll().catch((e) =>
        logger.error('[session-monitor] 定时扫描失败', e),
      );
    }, SCAN_INTERVAL_MS);
    this.timer.unref?.();
    logger.log('[session-monitor] 会话监测已启动（纯后台，零弹窗），每 3 分钟扫描一次');
  }

  /** 扫描所有已绑定平台账号，失效账号仅标记离线并记录日志，绝不弹窗 */
  async scanAll(): Promise<void> {
    try {
      if (!AppDataSource.isInitialized) return;
      const repo = AppDataSource.getRepository(AccountModel);
      const accounts = await repo.find();
      for (const account of accounts) {
        const type = account.type as PlatType;
        if (
          type !== PlatType.Douyin &&
          type !== PlatType.Xhs &&
          type !== PlatType.WxSph
        ) {
          continue;
        }
        const online = await this.checkSession(account);
        const nextStatus = online ? AccountStatus.USABLE : AccountStatus.DISABLE;
        if (account.status !== nextStatus) {
          await repo.update({ id: account.id }, { status: nextStatus });
          logger.info(
            '[session-monitor] 账号会话状态变更: id=%s type=%s online=%s',
            account.id,
            account.type,
            online,
          );
        }
      }
    } catch (e) {
      logger.error('[session-monitor] 扫描账号失败', e);
    }
  }

  /**
   * 会话有效性检测（纯只读）：
   * - 官方插件式平台（抖音/小红书/视频号）以共享分区浏览器 cookie 为准；
   * - cookie 判据失效不代表需要弹窗——只返回 false 让界面显示离线。
   */
  private async checkSession(account: AccountModel): Promise<boolean> {
    try {
      const type = account.type as PlatType;
      // 第一判据：共享分区 cookie。窗口刚重建/页面未加载完时 sessionid
      // 尚未写入分区，仅凭此会误标离线。
      if (await isPlatformSessionValid(type)) {
        return true;
      }
      // 兜底判据：账号持久化 cookie 直接过平台 API 复核。已登录账号
      // 绝不能被分区加载时序误伤成「离线」。
      const res = await platController
        .platLoginCheck(type, account)
        .catch(() => ({ online: false }));
      return res?.online === true;
    } catch (e) {
      logger.error('[session-monitor] 会话检测失败:', account.type, e);
      return account.status === AccountStatus.USABLE;
    }
  }
}

export const sessionMonitor = new SessionMonitor();
