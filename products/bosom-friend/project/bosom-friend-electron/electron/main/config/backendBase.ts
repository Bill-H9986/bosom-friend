/**
 * 后端地址与登录态运行时配置
 *
 * 内测/分发场景：测试者机器上无法访问本机的 127.0.0.1:8080，安装后在
 * %APPDATA%/<应用数据目录>/backend-config.json 写入 { "apiBaseUrl": "https://你的服务器/api" }
 * 重启应用即可连到共享后端。优先级：配置文件 > 环境变量 VITE_APP_URL > 本地默认。
 *
 * 登录态：桌面端为单机单用户客户端（内测阶段免账号登录，直接进入应用）。
 * token 由主进程持久存储（electron-store 'store-user'），无持久化登录态时
 * 自动签发内置管理员账号登录态——绝不出现登录页/登录弹窗。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { store } from '../../global/store'

let cached = ''

// 内置管理员账号（内测免登录模式）：与后端初始化脚本同一账号、同一密钥签发的长期 token
const DEFAULT_USER_ID = '6a793da81f0bfab8ad5d0648'
const DEFAULT_USER_MAIL = '2426891473@qq.com'
const DEFAULT_USER_NAME = '知音客户端'
const DEFAULT_AUTO_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhNzkzZGE4MWYwYmZhYjhhZDVkMDY0OCIsIm1haWwiOiIyNDI2ODkxNDczQHFxLmNvbSIsIm5hbWUiOiLnn6Xpn7PlrqLmiLfnq68iLCJpYXQiOjE3ODY4OTIxNzAsImV4cCI6MjEwMjI1MjE3MH0.KNKDQU70dBxn5IkZ93K4L9r5K-Eq5eeVo7AfRrZurH8'

export function getBackendBase(): string {
  if (cached) return cached
  cached = 'http://127.0.0.1:8080/api'
  try {
    const file = path.join(app.getPath('userData'), 'backend-config.json')
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (cfg && typeof cfg.apiBaseUrl === 'string' && cfg.apiBaseUrl.trim()) {
        cached = cfg.apiBaseUrl.trim().replace(/\/+$/, '')
      }
    }
  } catch {
    // 配置损坏时回退默认，不阻塞启动
  }
  const env = process.env.VITE_APP_URL
  if (env) cached = env.replace(/\/+$/, '')
  return cached
}

/** 读取/自愈持久化登录态（内测免登录模式：无登录态时自动签发内置账号） */
export function getAutoLoginToken(): string {
  try {
    const raw = store.get('store-user')
    const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : raw
    const token = parsed?.state?.token
    if (typeof token === 'string' && token) {
      return token
    }
  } catch {
    // 存储损坏时自愈重建
  }
  try {
    store.set('store-user', JSON.stringify({
      state: {
        token: DEFAULT_AUTO_TOKEN,
        userInfo: {
          _id: DEFAULT_USER_ID,
          id: DEFAULT_USER_ID,
          name: DEFAULT_USER_NAME,
          mail: DEFAULT_USER_MAIL,
          status: 1,
          userType: 'CREATOR',
          isDelete: false,
          score: 0,
          usedStorage: 0,
          storage: { total: 524288000 },
          locale: 'zh-CN',
        },
        hasEverLoggedIn: true,
        lang: 'zh-CN',
      },
    }))
  } catch {
    // 写失败仍返回内置 token，保证应用可进入
  }
  return DEFAULT_AUTO_TOKEN
}
