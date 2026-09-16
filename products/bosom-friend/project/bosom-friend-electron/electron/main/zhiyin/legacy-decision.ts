/**
 * 旧接待轮询 → 内核的统一决策桥 (v2.0-P0)
 *
 * 变更：双轨收敛开关 ZHIYIN_KERNEL_ONLY（默认ON）
 * - kernel-only=true：内核不可用时【不再返回null回退旧后端】
 *   而是抛出 KernelUnavailableError，由调用方进入重排队列，
 *   保证任意时刻只有一条确定性路径在跑（终结状态不一致BUG）。
 * - kernel-only=false：保持旧行为（回滚/灰度期使用）。
 *
 * 埋点 TODO(1.3.4)：调用方统计 decision.path ∈ rule|kernel|retry
 * 并写入 telemetry 事件（本模块保持零依赖，不直接 import telemetry）。
 */
import { getKernelRuntime } from '../zhiyin-kernel-host';

export interface ReceptionDecision {
  matched: boolean;
  reply?: string;
}

/** 内核在 kernel-only 模式下不可用（调用方必须排队重试，禁止回退） */
export class KernelUnavailableError extends Error {
  constructor(reason?: string) {
    super('DSH内核不可用: ' + (reason || 'runtime未初始化') + ' （kernel-only模式，禁止回退旧后端）');
    this.name = 'KernelUnavailableError';
  }
}

/** P0 收敛开关：环境变量 ZHIYIN_KERNEL_ONLY，默认ON（=1）；显式设0才关闭 */
function kernelOnly(): boolean {
  const v = process.env.ZHIYIN_KERNEL_ONLY;
  return v === undefined || v === '1' || v === 'true';
}

export async function decideReception(params: {
  message: string;
  platform?: string;
  source?: 'comment' | 'dm';
}): Promise<ReceptionDecision | null> {
  const runtime = getKernelRuntime();
  if (!runtime) {
    if (kernelOnly()) {
      // P0：不返回null兜底——让调用方进入重排队列（telemetry: decision.path='retry'）
      throw new KernelUnavailableError('runtime未初始化');
    }
    // 回滚/灰度：保留旧行为
    return null;
  }
  try {
    const result = (await runtime.invoke('automation.decide', {
      kind: params.source === 'dm' ? 'dm' : 'comment',
      content: params.message,
      platform: params.platform,
    })) as {
      ok?: boolean;
      data?: { matched?: boolean; reply?: string };
    } | null;
    if (!result || typeof result !== 'object') {
      if (kernelOnly()) throw new KernelUnavailableError('invoke返回空');
      return null;
    }
    if (result.ok && result.data) {
      return {
        matched: result.data.matched === true,
        reply: result.data.reply,
      };
    }
    if (kernelOnly()) throw new KernelUnavailableError('invoke失败: ' + JSON.stringify(result).slice(0, 120));
    return null;
  } catch (e) {
    if (e instanceof KernelUnavailableError) throw e;
    if (kernelOnly()) throw new KernelUnavailableError(String(e).slice(0, 120));
    return null;
  }
}