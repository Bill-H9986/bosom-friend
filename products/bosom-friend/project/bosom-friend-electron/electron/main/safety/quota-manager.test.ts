/**
 * 知音宿主 · QuotaManager 操作配额测试
 *
 * 覆盖每日上限、最小间隔、连续操作熔断、reportOperation 计数。
 * 宿主 store 依赖 electron 运行时，测试环境不可实例化，统一 vi.mock 掉。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuotaManager } from './quotaManager';

// 顶层 vi.mock：必须在 import 被测模块之前生效
vi.mock('../../global/store', () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

afterEach(() => {
  vi.useRealTimers();
});

describe('QuotaManager · 每日上限', () => {
  it('发布操作达到每日上限后拒绝', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const qm = new QuotaManager();
    // publish 每日上限 10
    for (let i = 0; i < 10; i++) qm.reportOperation('douyin', 2001, 'publish');

    const blocked = qm.canOperate('douyin', 2001, 'publish');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('已达上限');

    // 上限前最后一条仍允许
    // 新建一个账号验证未达上限时可操作
    expect(qm.canOperate('douyin', 2002, 'publish').ok).toBe(true);
  });
});

describe('QuotaManager · 最小间隔', () => {
  it('两次操作间隔不足时拒绝并给出 waitMs，间隔满足后放行', () => {
    vi.useFakeTimers();
    const start = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(start);
    const qm = new QuotaManager();
    // dm_reply 最小间隔 25s
    qm.reportOperation('douyin', 3001, 'dm_reply');

    const early = qm.canOperate('douyin', 3001, 'dm_reply');
    expect(early.ok).toBe(false);
    expect(early.waitMs).toBeGreaterThan(0);
    expect(early.reason).toContain('过于频繁');

    // 推进 25s 后放行
    vi.setSystemTime(new Date(start.getTime() + 25 * 1000 + 10));
    expect(qm.canOperate('douyin', 3001, 'dm_reply').ok).toBe(true);
  });
});

describe('QuotaManager · 连续操作熔断', () => {
  it('comment_reply 连续达到 burstLimit 后进入强制静默', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const qm = new QuotaManager();
    // comment_reply burstLimit = 6，最小间隔 12s。
    // 每次操作前推进 >12s，绕过最小间隔检查，只触发突发熔断。
    const base = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(new Date(base.getTime() + (i + 1) * 13 * 1000));
      qm.reportOperation('douyin', 4001, 'comment_reply');
    }

    // 最后一次操作后推进 >12s，绕过最小间隔检查，让突发熔断生效
    vi.setSystemTime(new Date(base.getTime() + 7 * 13 * 1000));
    const blocked = qm.canOperate('douyin', 4001, 'comment_reply');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('强制静默');
    expect(blocked.waitMs).toBeGreaterThan(0);

    // 熔断期结束后 resetBurst 可恢复
    qm.resetBurst('douyin', 4001, 'comment_reply');
    vi.setSystemTime(new Date(base.getTime() + 8 * 13 * 1000));
    expect(qm.canOperate('douyin', 4001, 'comment_reply').ok).toBe(true);
  });
});

describe('QuotaManager · reportOperation 计数', () => {
  it('getTodayUsage 如实反映今日各操作已用次数', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const qm = new QuotaManager();
    qm.reportOperation('douyin', 5001, 'publish');
    qm.reportOperation('douyin', 5001, 'publish');
    qm.reportOperation('douyin', 5001, 'comment_reply');

    const usage = qm.getTodayUsage('douyin', 5001);
    expect(usage.publish).toBe(2);
    expect(usage.comment_reply).toBe(1);
    expect(usage.dm_reply).toBe(0);
  });
});
