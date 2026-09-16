/**
 * Bosom Friend bundle 根模块。本包只是组合补丁层（cordis.patch.yml），
 * 提供的最小根模块仅为满足 tsdown/tsc 产物约定；运行时按子路径插件装载。
 * @module @deepseek-ai/dsh-bosom-friend-app
 */

export const name = 'bosom-friend-app'

export const inject: string[] = []

/** 根模块无运行行为；行为在补丁层插入的 @deepseek-ai/dsh-bosom-friend-server/api 插件中。 */
export function apply(): void { return undefined }
