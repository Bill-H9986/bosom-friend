/**
 * Bosom Friend新后端插件包。把已搬运的Bosom Friend(Bosom Friend) Web 前端整体接到 DeepSeek Harness
 * 上：本包在 dsh webServer 注册 `/bosom-friend/api/*` REST 路由（复刻前端期望的
 * `{code, data, message}` 信封与 Bearer 认证），并托管 `/bosom-friend/*` 静态应用。
 *
 * AI 对话域经 dsh-llm 服务由 DeepSeek 模型驱动；业务域数据落盘于
 * dataRoot 下的 JSONL/JSON 文件。组合方式见 products/opc/bundle/opc-app 的
 * cordis.patch.yml。
 * @module @deepseek-ai/dsh-bosom-friend-server
 */

export type * from './types.ts'
