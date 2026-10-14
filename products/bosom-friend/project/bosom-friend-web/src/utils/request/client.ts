import type { RequestData, RequestParams, RequestQuery } from './types'
import { createElement } from 'react'
import { directTrans } from '@web/app/i18n/client'
import { LOGIN_ENABLED } from '@web/config/auth'
import { useLoginDialogStore } from '@web/store/login-dialog'
import { useUserStore } from '@web/store/user'
import { notification } from '@web/utils/ui/notification'
import FetchService from './FetchService'

interface ResponseType<T> {
  code: string | number
  data: T
  message: string
  url: string
}

interface ApiErrorIssue {
  message?: string
  path?: unknown
}

type RequestParamsWithSilent = RequestParams & {
  silent?: boolean // 是否静默处理错误，不显示提示
  authToken?: string // 临时指定本次请求使用的 token
}

export type RequestOptions = Pick<RequestParamsWithSilent, 'authToken' | 'cache' | 'signal'>

// 后端地址运行时配置优先（主进程注入），内测分发场景可指向共享服务器
const runtimeBackendBase =
  typeof window !== 'undefined' ? (window as any).__BACKEND_BASE_URL__ : undefined;

const fetchService = new FetchService({
  baseURL: `${runtimeBackendBase || process.env.NEXT_PUBLIC_API_URL}/`,
  requestInterceptor(requestParams) {
    const authToken = 'authToken' in requestParams ? requestParams.authToken : undefined
    const token = authToken ?? useUserStore.getState().token
    requestParams.headers = {
      ...(requestParams.headers || {}),
      Authorization: token ? `Bearer ${token}` : '',
    }

    // 添加语言头
    if (typeof window !== 'undefined') {
      const lng = useUserStore.getState().lang
      requestParams.headers = {
        ...requestParams.headers,
        'Accept-Language': lng,
      }
    }

    return requestParams
  },
  responseInterceptor(response) {
    return response
  },
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getIssuePath(path: unknown) {
  if (!Array.isArray(path))
    return ''

  return path
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .join('.')
}

function getIssueText(issue: ApiErrorIssue) {
  const message = typeof issue.message === 'string' ? issue.message.trim() : ''
  const path = getIssuePath(issue.path)

  if (path && message)
    return `${path}: ${message}`
  return message || path
}

function getApiErrorDetails(errorData: unknown) {
  if (!isRecord(errorData) || !Array.isArray(errorData.issues))
    return []

  const platform = typeof errorData.platform === 'string' ? errorData.platform : ''

  return errorData.issues
    .map((issue) => {
      if (!isRecord(issue))
        return ''

      const issueText = getIssueText({
        message: typeof issue.message === 'string' ? issue.message : undefined,
        path: issue.path,
      })
      if (!issueText)
        return ''

      return platform ? `${platform} / ${issueText}` : issueText
    })
    .filter((detail): detail is string => detail.length > 0)
}

/** 从 API 错误数据中推断应聚焦的配置路径（渠道平台：['channel', <platform>]） */
function createApiErrorContent(
  message: string,
  details: string[] = [],
  showConfigTip = true,
) {
  return createElement(
    'div',
    { className: 'flex flex-col gap-1' },
    createElement('span', null, message),
    details.length > 0
      ? createElement(
          'ul',
          { className: 'mt-1 space-y-0.5 font-normal text-muted-foreground' },
          details.slice(0, 4).map(detail => createElement('li', { key: detail }, detail)),
        )
      : null,
  )
}

/** 前端请求失败的可判定原因。 */
interface RequestFailure {
  kind: 'unreachable' | 'timeout' | 'bad-response' | 'unknown'
  messageKey: 'backendUnreachable' | 'backendTimeout' | 'backendBadResponse' | 'networkError'
  detail: string
}

/**
 * 判定请求失败的真实原因。
 *
 * 只说「网络连接失败」会把三种处置方式完全不同的情况混成一句：内核已停（连接被拒）、
 * 后端卡住（超时）、后端返回了非 JSON（多为网关/代理错误页）。三者的下一步动作不同，
 * 必须分开——否则用户会一直去查自己的网络，而真正停掉的是本地内核（DEF-083）。
 *
 * @param error - fetch 抛出或 res.json() 抛出的异常。
 * @returns 分类结果：kind 供日志，messageKey 供提示文案。
 */
function classifyRequestFailure(error: unknown): RequestFailure {
  const detail = error instanceof Error
    ? error.name + ': ' + error.message
    : String(error)
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'TimeoutError')
    return { kind: 'timeout', messageKey: 'backendTimeout', detail }
  if (error instanceof SyntaxError)
    return { kind: 'bad-response', messageKey: 'backendBadResponse', detail }
  if (error instanceof TypeError)
    return { kind: 'unreachable', messageKey: 'backendUnreachable', detail }
  return { kind: 'unknown', messageKey: 'networkError', detail }
}

function getApiErrorMessage(data: ResponseType<unknown>, fallback: string) {
  let message = data.message || fallback
  // 5xx / 服务不可用：转中文友好提示，不把后端原始英文（Internal server error）直接抛给用户
  if (
    data.code === 500
    || data.code === 502
    || data.code === 503
    || /internal server error|service unavailable|bad gateway/i.test(message)
  ) {
    message = directTrans('common', 'serviceUnavailable')
  }
  if (data.code !== 16183 || !isRecord(data.data) || typeof data.data.field !== 'string') {
    return message
  }

  return message
    .split(data.data.field)
    .join('')
    .replace(/：\s+/g, '：')
    .replace(/:\s{2,}/g, ': ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export async function request<T>(params: RequestParamsWithSilent) {
  try {
    let res = await fetchService.request(params)
    // GET 请求遇 5xx（后端重启/瞬时故障）自动重试一次，提升数据加载韧性
    if (
      params.method === 'GET'
      && res.status >= 500
      && !params.silent
    ) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      res = await fetchService.request(params)
    }
    const data: ResponseType<T> = await res.json()

    // 使用项目的静态翻译方法（只使用国际化字段，不再使用硬编码回退）
    const networkBusy = directTrans('common', 'networkBusy')

    if (data.code === 401 || data.code === 12000) {
      // 会话失效：清空本地登录态并唤起登录框；登录/注册/登出自身请求除外
      if (LOGIN_ENABLED && data.code === 401 && typeof window !== 'undefined') {
        const urlPath = String(params.url || '')
        const isAuthRoute = /(^|\/)auth\/(login|register|logout)(\/|$)/.test(urlPath)
        if (!isAuthRoute) {
          useUserStore.getState().logout()
          useLoginDialogStore.getState().openLoginDialog({ fromGuard: true })
        }
      }
      return data
    }

    // 后端就绪标记：成功收到业务响应即视为后端已可用（启动期误报治理）
    if (typeof window !== 'undefined' && data.code === 0)
      (window as any).__zyNetOk = true

    if (data.code !== 0) {
      data.message = getApiErrorMessage(data, networkBusy)
      if (!params.silent && typeof window !== 'undefined') {
        const errorDetails = getApiErrorDetails(data.data)
        notification.warning({
          // Bosom Friend客户端已内置并固化全部后端配置（模型 Key/邮箱/中继等），
          // 不再引导用户打开“配置管理”编辑后端配置，配置错误仅提示信息。
          content: createApiErrorContent(data.message, errorDetails, false),
          key: 'apiErrorMessage',
          duration: errorDetails.length > 0 ? 6 : 3,
        })
      }
      return data
    }

    return data
  }
  catch (e) {
    // 组件卸载/路由切换触发的请求中止不是错误，静默返回，不弹网络异常提示
    if (e instanceof DOMException && e.name === 'AbortError') {
      return null
    }
    const failure = classifyRequestFailure(e)
    // 失败必须留痕：此前前端只在界面上闪一句「网络连接失败」，什么都不落盘，
    // 事后既不知道是哪个接口、也不知道是连接被拒还是超时/网关错误页。
    // 桌面壳会把这些控制台行抄进当天运行日志（logs/YYYY-MM-DD.log）。
    if (!params.silent) {
      console.error('[req] 请求失败 url=' + String(params.url)
        + ' method=' + String(params.method || 'GET')
        + ' cause=' + failure.kind
        + ' detail=' + failure.detail)
    }
    if (
      (useUserStore.getState().token || params.url.includes('login/'))
      && !params.silent
      && typeof window !== 'undefined'
    ) {
      // 启动期（后端尚未成功响应过一次）的失败一律视为「启动中」，
      // 避免后端冷启动窗口内轮询失败被误报为断网。
      const backendReady = typeof window !== 'undefined' && (window as any).__zyNetOk === true
      const errText = backendReady
        ? directTrans('common', failure.messageKey)
        : directTrans('common', 'backendStarting')
      notification.error({
        content: createApiErrorContent(errText),
        key: 'apiErrorMessage',
        duration: backendReady ? 4 : 2,
      })
    }
    return null
  }
}

export default {
  get<T>(url: string, data?: RequestQuery, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      params: data,
      method: 'GET',
      silent,
    })
  },
  post<T>(url: string, data?: RequestData, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      data,
      method: 'POST',
      silent,
    })
  },
  put<T>(url: string, data?: RequestData, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      data,
      method: 'PUT',
      silent,
    })
  },
  delete<T>(url: string, data?: RequestData, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      data,
      method: 'DELETE',
      silent,
    })
  },
  patch<T>(url: string, data?: RequestData, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      data,
      method: 'PATCH',
      silent,
    })
  },
}
