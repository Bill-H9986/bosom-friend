import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// DEF-240-IMPLEMENT-3 隔离测试专用配置：
// - 只跑产品侧授权闸门测试，不并入 DSH 官方 lane（那些 lane 的 include 只覆盖 apps/ 与 packages/）；
// - 不连接任何真实平台：执行器一律用替身；
// - 别名显式声明（不用 vite-tsconfig-paths，避免 projects 基准歧义）。
const webSrc = fileURLToPath(new URL('../../project/bosom-friend-web/src/', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^@web\//, replacement: webSrc }],
  },
  test: {
    include: ['products/bosom-friend/qa/isolation/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
})