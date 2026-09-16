import type { AuthRequestOptions, ChangePasswordParams, CodeLoginResponse, EmailCodeLoginParams, GoogleLoginParams, LoginResponse, PhoneCodeLoginParams, RegisterParams, SendEmailCodeParams, SendPhoneCodeParams, UpdateUserInfoParams, UsernameLoginParams } from './auth.types'
import type { UserInfo } from '@web/store/user'
import type { RequestOptions } from '@web/utils/request'
import http from '@web/utils/request/client'

/** 发送邮箱验证码 */
export function sendEmailCodeApi(data: SendEmailCodeParams) {
  return http.post<null>('login/mail', data)
}

/** 邮箱验证码登录 */
export function emailCodeLoginApi(data: EmailCodeLoginParams) {
  return http.post<CodeLoginResponse>('login/mail/verify', data)
}

/** 发送手机验证码 */
export function sendPhoneCodeApi(data: SendPhoneCodeParams) {
  return http.post<null>('login/phone', data)
}

/** 手机验证码登录 */
export function phoneCodeLoginApi(data: PhoneCodeLoginParams) {
  return http.post<CodeLoginResponse>('login/phone/verify', data)
}

/**
 * Get Current User Information
 * Retrieve the profile of the authenticated user.
 */
export function getUserInfoApi(options?: RequestOptions & AuthRequestOptions) {
  const { silent, ...requestOptions } = options ?? {}
  return http.get<UserInfo>('user/mine', undefined, silent, requestOptions)
}

/**
 * Update User Information
 * Update the profile of the authenticated user.
 */
export function updateUserInfoApi(data: UpdateUserInfoParams) {
  return http.put<UserInfo>('user/info/update', data)
}

/**
 * 用户名 + 密码登录
 * 本地账号体系：后端校验 scrypt 哈希，成功返回会话 token 与用户信息。
 */
export function usernameLoginApi(data: UsernameLoginParams) {
  return http.post<LoginResponse>('auth/login', data)
}

/**
 * 注册本地账号
 * 首次使用（无账号）或新增账号时调用，成功后直接建立会话。
 */
export function registerApi(data: RegisterParams) {
  return http.post<LoginResponse>('auth/register', data)
}

/**
 * 退出登录
 * 注销服务端会话 token。
 */
export function logoutApi() {
  return http.post<{ ok: boolean }>('auth/logout')
}

/**
 * 修改密码
 * 校验原密码后重哈希，其余会话一并失效（仅保留当前会话）。
 */
export function changePasswordApi(data: ChangePasswordParams) {
  return http.put<{ ok: boolean }>('auth/password', data)
}

/**
 * Google 登录
 * 使用 Google 凭证登录用户。
 */
export function googleLoginApi(data: GoogleLoginParams) {
  return http.post<LoginResponse>('login/google', data)
}
