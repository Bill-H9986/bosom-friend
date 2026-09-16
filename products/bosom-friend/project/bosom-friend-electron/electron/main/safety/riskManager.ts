/*
 * 平台安全防护层：风控识别 + 指数退避 + 账号隔离
 * 每个平台规则不同，统一在这里管理"什么时候该停手"
 */
import { store } from '../../global/store';

export type RiskLevel = 'normal' | 'cooling' | 'blocked';

export interface RiskState {
  level: RiskLevel;
  coolingUntil: number;
  strikes: number;
  reason: string;
  updatedAt: number;
}

// 退避阶梯：连续触发次数 -> 冷却时长
const BACKOFF_STEPS = [
  10 * 60 * 1000, // 第 1 次：冷却 10 分钟
  30 * 60 * 1000, // 第 2 次：冷却 30 分钟
  2 * 60 * 60 * 1000, // 第 3 次：冷却 2 小时
  6 * 60 * 60 * 1000, // 第 4 次：冷却 6 小时
];

export function randomRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 各平台风控响应的典型特征（文案统一匹配，命中即视为风控）
const RISK_KEYWORDS = [
  '未登录',
  '登录已过期',
  '验证码',
  'captcha',
  '频率过高',
  '操作频繁',
  '频繁',
  'risk',
  '风控',
  'denied',
  'blocked',
  '违规',
  '不安全',
  '403',
  '请重新授权',
  '账号异常',
  'account abnormal',
  '300011',
];

/**
 * 判断一次平台响应/错误信息是否为风控信号
 */
export function isRiskResponse(message: string | undefined | null, httpStatus?: number): boolean {
  if (httpStatus === 403 || httpStatus === 429) return true;
  if (!message) return false;
  const text = String(message).toLowerCase();
  return RISK_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

export class RiskManager {
  private states = new Map<string, RiskState>();
  private readonly storeKey = 'platform_risk_states';

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const saved = store.get(this.storeKey) as Record<string, RiskState> | undefined;
      if (saved && typeof saved === 'object') {
        for (const [k, v] of Object.entries(saved)) {
          if (v && typeof v.level === 'string') {
            this.states.set(k, v);
          }
        }
      }
    } catch {
      // 持久化读取失败不阻塞运行
    }
  }

  private persist(): void {
    try {
      const data: Record<string, RiskState> = {};
      for (const [k, v] of this.states.entries()) {
        data[k] = v;
      }
      store.set(this.storeKey, data);
    } catch {
      // 持久化写入失败不阻塞运行
    }
  }

  private key(platform: string, accountId: number | string): string {
    return `${platform}:${accountId}`;
  }

  /**
   * 上报一次风控事件（识别到风控响应后调用）
   */
  reportRisk(platform: string, accountId: number | string, reason: string): RiskState {
    const k = this.key(platform, accountId);
    const prev = this.states.get(k);
    const strikes = (prev?.strikes || 0) + 1;
    const stepIndex = Math.min(strikes - 1, BACKOFF_STEPS.length - 1);
    const coolingMs = BACKOFF_STEPS[stepIndex];
    const level: RiskLevel = strikes >= 4 ? 'blocked' : 'cooling';
    const state: RiskState = {
      level,
      coolingUntil: Date.now() + (level === 'blocked' ? Number.MAX_SAFE_INTEGER : coolingMs),
      strikes,
      reason,
      updatedAt: Date.now(),
    };
    this.states.set(k, state);
    this.persist();
    console.error(
      `[risk-manager] ${platform} 账号 ${accountId} 触发风控(${strikes}次): ${reason}，` +
        (level === 'blocked' ? '已标记为严重风控，需人工处理' : `冷却至 ${new Date(state.coolingUntil).toLocaleString('zh-CN')}`),
    );
    return state;
  }

  /**
   * 判断账号当前是否可执行自动操作
   */
  canOperate(
    platform: string,
    accountId: number | string,
  ): { ok: boolean; state?: RiskState; waitMs?: number } {
    const state = this.states.get(this.key(platform, accountId));
    if (!state || state.level === 'normal') {
      return { ok: true };
    }
    if (state.level === 'blocked') {
      return { ok: false, state, waitMs: Number.MAX_SAFE_INTEGER };
    }
    const waitMs = state.coolingUntil - Date.now();
    if (waitMs > 0) {
      return { ok: false, state, waitMs };
    }
    // 冷却期已过，自动恢复
    this.states.set(this.key(platform, accountId), {
      level: 'normal',
      coolingUntil: 0,
      strikes: 0,
      reason: '',
      updatedAt: Date.now(),
    });
    this.persist();
    return { ok: true };
  }

  /**
   * 操作成功后清零连续触发次数（防止历史风控长期累积）
   */
  reportSuccess(platform: string, accountId: number | string): void {
    const k = this.key(platform, accountId);
    const prev = this.states.get(k);
    if (prev && (prev.level === 'cooling' || prev.strikes > 0)) {
      this.states.set(k, {
        level: 'normal',
        coolingUntil: 0,
        strikes: 0,
        reason: '',
        updatedAt: Date.now(),
      });
      this.persist();
    }
  }

  /**
   * 获取账号当前风控状态
   */
  getStatus(platform: string, accountId: number | string): RiskState {
    const state = this.states.get(this.key(platform, accountId));
    if (!state) {
      return { level: 'normal', coolingUntil: 0, strikes: 0, reason: '', updatedAt: 0 };
    }
    return state;
  }

  /**
   * 手动解除风控（用户确认账号恢复正常后）
   */
  clearRisk(platform: string, accountId: number | string): void {
    this.states.delete(this.key(platform, accountId));
    this.persist();
  }
}

export const riskManager = new RiskManager();
