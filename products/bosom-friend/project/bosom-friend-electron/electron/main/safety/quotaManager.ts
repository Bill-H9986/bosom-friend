/*
 * 操作配额管理：每日上限 + 最小间隔 + 连续操作强制静默
 * 参考竞品安全策略：单账号单日操作上限、突发熔断、人类化节奏
 */
import { store } from '../../global/store';

export type OperationType = 'dm_reply' | 'comment_reply' | 'publish';

interface QuotaConfig {
  dailyLimit: number;
  minIntervalMs: number;
  burstLimit: number;
  burstCooldownMs: number;
}

// 各操作的安全配额（保守起步，后续按平台表现动态调整）
const QUOTA_CONFIG: Record<OperationType, QuotaConfig> = {
  dm_reply: {
    dailyLimit: 80, // 每天最多自动回复 80 条私信
    minIntervalMs: 25 * 1000, // 两次私信回复至少间隔 25 秒
    burstLimit: 4, // 连续 4 条后强制休息
    burstCooldownMs: 90 * 1000, // 休息 90 秒
  },
  comment_reply: {
    dailyLimit: 120, // 每天最多自动回复 120 条评论
    minIntervalMs: 12 * 1000, // 两次评论回复至少间隔 12 秒
    burstLimit: 6, // 连续 6 条后强制休息
    burstCooldownMs: 120 * 1000, // 休息 2 分钟
  },
  publish: {
    dailyLimit: 10, // 每天最多发布 10 个作品
    minIntervalMs: 30 * 60 * 1000, // 两次发布至少间隔 30 分钟
    burstLimit: 2, // 连续发布 2 个后强制休息
    burstCooldownMs: 10 * 60 * 1000, // 休息 10 分钟
  },
};

export class QuotaManager {
  private readonly storeKey = 'platform_op_quota';
  private daily = new Map<string, number>();
  private lastOpAt = new Map<string, number>();
  private burstCount = new Map<string, number>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const saved = store.get(this.storeKey) as Record<string, number> | undefined;
      if (saved) {
        for (const [k, v] of Object.entries(saved)) {
          this.daily.set(k, v);
        }
      }
    } catch {
      // 读取失败不阻塞
    }
  }

  private persist(): void {
    try {
      const data: Record<string, number> = {};
      for (const [k, v] of this.daily.entries()) {
        data[k] = v;
      }
      store.set(this.storeKey, data);
    } catch {
      // 写入失败不阻塞
    }
  }

  private key(platform: string, accountId: number | string, op: OperationType, dateKey?: string): string {
    const d = dateKey || new Date().toISOString().slice(0, 10);
    return `${platform}:${accountId}:${op}:${d}`;
  }

  /**
   * 检查当前是否允许执行该操作
   */
  canOperate(
    platform: string,
    accountId: number | string,
    op: OperationType,
  ): { ok: boolean; reason?: string; waitMs?: number } {
    const cfg = QUOTA_CONFIG[op];
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = this.key(platform, accountId, op, today);
    const lastKey = `${platform}:${accountId}:${op}:last`;
    const burstKey = `${platform}:${accountId}:${op}:burst`;

    // 1. 每日上限
    const dailyCount = this.daily.get(dailyKey) || 0;
    if (dailyCount >= cfg.dailyLimit) {
      return { ok: false, reason: `今日${op}已达上限(${cfg.dailyLimit}次)，明天自动恢复` };
    }

    // 2. 操作最小间隔
    const lastAt = this.lastOpAt.get(lastKey) || 0;
    const sinceLast = Date.now() - lastAt;
    if (sinceLast < cfg.minIntervalMs) {
      return {
        ok: false,
        reason: `${op}过于频繁`,
        waitMs: cfg.minIntervalMs - sinceLast,
      };
    }

    // 3. 突发熔断：连续操作达到上限后强制静默
    const burst = this.burstCount.get(burstKey) || 0;
    if (burst >= cfg.burstLimit) {
      return {
        ok: false,
        reason: `连续${op}次数过多，进入强制静默期`,
        waitMs: cfg.burstCooldownMs,
      };
    }

    return { ok: true };
  }

  /**
   * 记录一次成功操作
   */
  reportOperation(platform: string, accountId: number | string, op: OperationType): void {
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = this.key(platform, accountId, op, today);
    const lastKey = `${platform}:${accountId}:${op}:last`;
    const burstKey = `${platform}:${accountId}:${op}:burst`;

    this.daily.set(dailyKey, (this.daily.get(dailyKey) || 0) + 1);
    this.lastOpAt.set(lastKey, Date.now());
    this.burstCount.set(burstKey, (this.burstCount.get(burstKey) || 0) + 1);
    this.persist();
  }

  /**
   * 强制静默期结束后清零突发计数
   */
  resetBurst(platform: string, accountId: number | string, op: OperationType): void {
    const burstKey = `${platform}:${accountId}:${op}:burst`;
    this.burstCount.delete(burstKey);
  }

  /**
   * 获取账号今日各操作已用次数
   */
  getTodayUsage(
    platform: string,
    accountId: number | string,
  ): Record<OperationType, number> {
    const today = new Date().toISOString().slice(0, 10);
    return {
      dm_reply: this.daily.get(this.key(platform, accountId, 'dm_reply', today)) || 0,
      comment_reply: this.daily.get(this.key(platform, accountId, 'comment_reply', today)) || 0,
      publish: this.daily.get(this.key(platform, accountId, 'publish', today)) || 0,
    };
  }
}

export const quotaManager = new QuotaManager();
