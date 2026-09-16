import type { AccountGroupItem, AccountListData, AccountStatsRefreshResult, CreateChannelAccountParams, SocialAccount, SortRankRequest } from './account.types'
import http from '@web/utils/request'

// Source: account.ts
function buildArrayQueryUrl(path: string, key: string, values: string[]) {
  const query = new URLSearchParams()
  values.forEach(value => query.append(key, value))
  return `${path}?${query.toString()}`
}

/**
 * 创建账号
 * 仅支持插件授权平台创建账号
 */
export function createChannelAccountApi(data: CreateChannelAccountParams) {
  return http.post<SocialAccount>('v2/channels/accounts', data)
}

/**
 * 账号列表
 */
export function getAccountListApi(silent = false) {
  return http.get<AccountListData>('v2/channels/accounts', undefined, silent)
}

/**
 * 账号详情
 */
export function getAccountDetailApi(id: string) {
  return http.get<SocialAccount>(`v2/channels/accounts/${id}`)
}

/**
 * 触发一次账号真实数据采集（「刷新粉丝数」）。
 * 返回的是本次请求真正做了什么：completed=已真实采集完，started=已在后台采集，
 * in_flight=上一轮还在跑，throttled=仍在刷新间隔内。失败会带平台给出的原因（code!==0）。
 * 静默请求：提示由 useFansRefresh 统一按真实状态给出，避免出现"刷新完成"的假成功。
 */
export function refreshAccountFansApi(id: string) {
  return http.post<AccountStatsRefreshResult>(
    `v2/channels/accounts/${encodeURIComponent(id)}/analytics/refresh`,
    {},
    true,
  )
}

/**
 * 删除账号
 */
export function deleteAccountApi(id: string) {
  return http.delete<boolean>(`v2/channels/accounts/${id}?confirm=1`)
}

/**
 * 退出平台账号登录（保留账号与历史统计，仅清除平台会话）。
 */
export function logoutAccountApi(id: string) {
  return http.post<SocialAccount>(`v2/channels/accounts/${encodeURIComponent(id)}/logout`, {}, true)
}

/**
 * 创建账号分组
 */
export function createAccountGroupApi(data: Partial<AccountGroupItem>) {
  return http.post<AccountGroupItem>('v2/channels/account-groups', data)
}

/**
 * 更新账号分组
 */
export function updateAccountGroupApi(data: Partial<AccountGroupItem>) {
  const { id, ...payload } = data
  return http.patch<AccountGroupItem>(`v2/channels/account-groups/${id}`, payload)
}

/**
 * 删除账号分组
 */
export function deleteAccountGroupApi(ids: string[]) {
  return http.delete<boolean>(buildArrayQueryUrl('v2/channels/account-groups', 'ids', ids))
}

/**
 * 账号分组列表
 */
export function getAccountGroupApi() {
  return http.get<AccountGroupItem[]>('v2/channels/account-groups')
}

/**
 * 更新分组排序
 * @param data 排序数据
 * @returns 排序更新结果
 */
export async function apiUpdateAccountGroupSortRank(data: SortRankRequest) {
  const results = await Promise.all(
    data.list.map(item => http.patch(`v2/channels/account-groups/${item.id}`, { rank: item.rank })),
  )

  const failedResult = results.find(result => result?.code !== 0)
  return failedResult ?? { code: 0, data: true, message: '', url: '' }
}
