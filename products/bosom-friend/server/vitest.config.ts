import { defineConfig } from 'vitest/config'

/**
 * 产品服务端「功能测试」配置：直接把插件路由表挂进进程内驱动，不起服务、不开浏览器。
 *
 * 这样测的是**逻辑**：路由契约（信封/业务码/字段层级）、状态机、落盘副作用、批量删除语义…
 * 失败时 vitest 直接给出断言位置与期望/实际值，可 `vitest --inspect-brk` 断点调试。
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
    },
  },
})
