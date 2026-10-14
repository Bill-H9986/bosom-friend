/**
 * 包级 invariant 占位：本包为组合补丁层，不产生会话事件。
 * @module @deepseek-ai/dsh-bosom-friend-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'bosom-friend-app-invariant'

export const inject = ['invariants']

const install: InvariantInstaller = Object.assign((_ctx: Context, fail: InvariantFailure) => {
  // No runtime invariant: 本包为组合补丁层，不产生会话事件。
  void fail
}, {})

/**
 * 注册本包的 invariant 伴侣。
 * @param ctx - 带 invariants 服务的上下文。
 * @returns 注册注销函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-bosom-friend-app', install))
