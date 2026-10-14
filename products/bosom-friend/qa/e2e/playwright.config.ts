import { defineConfig } from '@playwright/test'

/**
 * Bosom Friend 端到端测试配置。
 *
 * 目标是「专业套件」而不是一次性脚本：统一 runner、HTML 报告、失败留 trace/截图/录屏。
 * 被测对象是**正在运行的开发实例**（默认 http://127.0.0.1:31280），
 * 因此 workers=1（同一个实例，避免用例互相干扰），并在断言里自带清理。
 */
/**
 * 靶子地址：**必须显式指向一个隔离实例**（2026-10-13）。
 *
 * 为什么不再默认打 31280：31280 是开发实例，数据根就是用户的真实数据根
 * （~/.bosom-friend/bosom-friend）。本套件里有「清空全部生成记录」「批量删除」这类
 * **全局破坏性**用例——默认打真实实例等于"跑一次测试清一次用户数据"：
 * 2026-10-13 10:35–10:36 的真实数据被清空，四个文件就是被这类删除路径写空的。
 *
 * 正确用法（先起隔离实例，再把地址交给这里）：
 *   node products/bosom-friend/qa/run-isolated.mjs      # 它会设 BF_QA_BASE 并跑套件
 * 或自建隔离实例后：
 *   BF_QA_BASE=http://127.0.0.1:31299/bosom-friend/ npx playwright test
 *
 * 确需打真实实例（只读排查）时，显式声明：BF_QA_ALLOW_LIVE=1。
 */
const BASE = process.env.BF_QA_BASE ?? ''
if (BASE === '') {
  throw new Error('qa/e2e 拒绝运行：没有指定靶子。请先 node products/bosom-friend/qa/run-isolated.mjs（推荐），或把 BF_QA_BASE 指向一个隔离实例；确需打真实实例时显式设 BF_QA_ALLOW_LIVE=1。')
}
if (/127\.0\.0\.1:31280|localhost:31280/.test(BASE) && process.env.BF_QA_ALLOW_LIVE !== '1') {
  throw new Error('qa/e2e 拒绝把 31280（开发实例、真实数据根）当作靶子：本套件含全局删除用例，跑一次就会清掉用户数据。请用隔离实例（qa/run-isolated.mjs），确需打真实实例时显式设 BF_QA_ALLOW_LIVE=1。当前靶子：' + BASE)
}

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
