/**
 * 账号登录开关。
 * false = 临时屏蔽登录页（免登录单用户模式，后端守卫同步关闭）；
 * 恢复账号体系时改回 true（后端 cordis.patch.yml 的 authEnabled 同步改回 true）。
 */
export const LOGIN_ENABLED = false
