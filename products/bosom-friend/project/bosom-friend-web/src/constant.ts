// 代理地址
export const ProxyUrls = [
  '/api/',
]

// 联系方式
export const CONTACT = '2426891473@qq.com'

// true=国内
export const isChina = process.env.NEXT_PUBLIC_REGION === 'Domestic'

// 测试服 API 地址
export const TEST_API_URL = 'https://dev.bosomfriend.local/api'

// 当前是否为测试服
export const isTestApiServer = false

// 当前是否为开发/测试环境
export const isDevOrTestEnv = process.env.NEXT_PUBLIC_EVN === 'dev' || isTestApiServer

// 浏览器插件最新版本号
export const PluginVersionLast = '3.2.6'
