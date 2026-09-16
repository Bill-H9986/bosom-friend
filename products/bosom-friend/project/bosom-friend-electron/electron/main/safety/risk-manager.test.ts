/**
 * 知音宿主 · RiskManager 风控防护层测试
 *
 * 覆盖 isRiskResponse 命中判定、指数退避冷却阶梯、严重风控封锁/恢复、账号隔离。
 * 宿主 store 依赖 electron 运行时，测试环境不可实例化，统一 vi.mock 掉。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiskManager, isRiskResponse } from './riskManager';

// 顶层 vi.mock：必须在 import 被测模块之前生效
vi.mock('../../global/store', () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

afterEach(() => {
  vi.useRealTimers();
});

describe('RiskManager · isRiskResponse 风控信号识别', () => {
  it('命中风控关键词（如"频繁"）返回 true', () => {
    expect(isRiskResponse('操作频繁，请稍后再试')).toBe(true);
    expect(isRiskResponse('触发平台风控')).toBe(true);
    expect(isRiskResponse('账号异常')).toBe(true);
  });

  it('普通文案返回 false', () => {
    expect(isRiskResponse('发布成功')).toBe(false);
    expect(isRiskResponse('这是一条正常的业务消息')).toBe(false);
  });

  it('httpStatus 触发（429/403）返回 true，且大小写不敏感', () => {
    expect(isRiskResponse('some text', 429)).toBe(true);
    expect(isRiskResponse('some text', 403)).toBe(true);
    expect(isRiskResponse('RISK detected')).toBe(true);
    expect(isRiskResponse(undefined, 200)).toBe(false);
  });
});

describe('RiskManager · 指数退避冷却阶梯', () => {
  it('连续触发冷却时长递增：10min → 30min → 2h，第 4 次进入 blocked', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const rm = new RiskManager();
    const account = 1001;

    rm.reportRisk('douyin', account, '频繁');
    expect(rm.getStatus('douyin', account).level).toBe('cooling');
    expect(rm.getStatus('douyin', account).coolingUntil - Date.now()).toBe(10 * MIN);

    rm.reportRisk('douyin', account, '频繁');
    expect(rm.getStatus('douyin', account).coolingUntil - Date.now()).toBe(30 * MIN);

    rm.reportRisk('douyin', account, '频繁');
    expect(rm.getStatus('douyin', account).coolingUntil - Date.now()).toBe(2 * HOUR);

    // 第 4 次触发达到严重风控阈值 → 直接 blocked（冷却为 MAX_SAFE_INTEGER，非 6h）
    rm.reportRisk('douyin', account, '频繁');
    expect(rm.getStatus('douyin', account).level).toBe('blocked');
    expect(rm.canOperate('douyin', account).ok).toBe(false);
  });

  it('冷却期内 canOperate 拒绝并给出等待时长，冷却期后自动恢复', () => {
    vi.useFakeTimers();
    const start = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(start);
    const rm = new RiskManager();
    const account = 1002;

    rm.reportRisk('douyin', account, '操作频繁');
    const blocked = rm.canOperate('douyin', account);
    expect(blocked.ok).toBe(false);
    expect(blocked.waitMs).toBe(10 * MIN);

    // 推进到冷却期之后（10min 冷却已过）
    vi.setSystemTime(new Date(start.getTime() + 10 * MIN + 1000));
    const recovered = rm.canOperate('douyin', account);
    expect(recovered.ok).toBe(true);
    // 自动恢复为 normal
    expect(rm.getStatus('douyin', account).level).toBe('normal');
  });
});

describe('RiskManager · 严重风控封锁与恢复', () => {
  it('达到严重风控阈值后 level=blocked、canOperate 拒绝、reportSuccess 可恢复', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const rm = new RiskManager();
    const account = 1003;

    // 连续 4 次触发 → 进入 blocked（阈值即 BACKOFF_STEPS 长度=4）
    for (let i = 0; i < 4; i++) rm.reportRisk('douyin', account, '严重违规');

    expect(rm.getStatus('douyin', account).level).toBe('blocked');
    const blocked = rm.canOperate('douyin', account);
    expect(blocked.ok).toBe(false);
    expect(blocked.waitMs).toBe(Number.MAX_SAFE_INTEGER);

    // 操作成功 → 清零，恢复可操作
    rm.reportSuccess('douyin', account);
    expect(rm.getStatus('douyin', account).level).toBe('normal');
    expect(rm.canOperate('douyin', account).ok).toBe(true);
  });
});

describe('RiskManager · 账号隔离', () => {
  it('平台 A 冷却不影响平台 B', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const rm = new RiskManager();
    const account = 1004;

    rm.reportRisk('douyin', account, '频繁');
    expect(rm.canOperate('douyin', account).ok).toBe(false);
    // 同账号不同平台不受影响
    expect(rm.canOperate('xhs', account).ok).toBe(true);
    // 同平台不同账号也不受影响
    expect(rm.canOperate('douyin', account + 1).ok).toBe(true);
  });
});
