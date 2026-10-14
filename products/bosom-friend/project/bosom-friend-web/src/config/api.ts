/**
 * Bosom Friend API 地址：默认走 dev-proxy（8080），由代理分发到后端与 AI 服务；
 * 打包分发场景由主进程注入运行时地址（backend-config.json 配置共享服务器）
 */
export const WEB_API_BASE_URL =
  (typeof window !== 'undefined' ? (window as any).__BACKEND_BASE_URL__ : undefined)
  || '/bosom-friend/api'
