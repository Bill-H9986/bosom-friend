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
    // 镜间主动间隔在生产是 90 秒（免费档每分钟 1 次限流）：测试里必须压到毫秒级，
    // 否则每条多镜用例都真等 90 秒 → 60 秒超时，套件判不出行为对错（DEF-265）。
    env: { BOSOM_SHOT_INTERVAL_MS: '50', BOSOM_RATE_LIMIT_RETRY_MS: '80' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
    },
  },
})
