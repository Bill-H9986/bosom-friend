/**
 * 知音内核运行时单例访问器（独立模块，避免宿主桥与知识库桥互相 import 成环）
 */
import type { HarnessRuntime } from '../../../../bosom-friend-harness/src/index';

let kernelRuntime: HarnessRuntime | null = null;

export function setKernelRuntime(runtime: HarnessRuntime | null): void {
  kernelRuntime = runtime;
}

export function getKernelRuntime(): HarnessRuntime | null {
  return kernelRuntime;
}
