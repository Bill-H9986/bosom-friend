import { defineConfig } from '@playwright/test'

/**
 * Bosom Friend 端到端测试配置。
 *
 * 目标是「专业套件」而不是一次性脚本：统一 runner、HTML 报告、失败留 trace/截图/录屏。
 * 被测对象是**正在运行的开发实例**（默认 http://127.0.0.1:31280），
 * 因此 workers=1（同一个实例，避免用例互相干扰），并在断言里自带清理。
 */
const BASE = process.env.BF_QA_BASE ?? 'http://127.0.0.1:31280/bosom-friend/'

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'report', open: 'never' }],
    ['json', { outputFile: 'report/results.json' }],
  ],
  use: {
    baseURL: BASE,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'zh-CN',
  },
})
