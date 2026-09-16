/*
 * @Author: nevin
 * @Date: 2025-01-17 20:21:04
 * @LastEditTime: 2025-02-27 16:57:37
 * @LastEditors: nevin
 * @Description: 请求
 */
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { message } from 'antd';
import { useUserStore } from '@/store/user';
import { useNetStatusStore } from '@/store/netStatusStore';

interface ProjectAxiosRequestConfig extends AxiosRequestConfig {
  // 是否需要token，默认为true，为false表示不需要token，需要token的接口如果不存在token会被拦截
  isToken?: boolean;
}

export const getAxiosRequest = (baseURL: string) => {
  const MessageKey = 'reqKey';

  // 创建 axios 实例
  const request = axios.create({
    baseURL, // 从环境变量获取基础URL
    timeout: 15000, // 请求超时时间
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // 请求拦截器
  request.interceptors.request.use(
    (config) => {
      // 获取 token
      const token = useUserStore.getState().token;

      // @ts-ignore 如果没有token或者不在白名单内将接口拦截
      if (token === '' && config.isToken !== false) {
        console.log('接口拦截：', config.url);
        return Promise.reject();
      }

      // @ts-ignore
      if (config!.isToken !== false) {
        useUserStore.getState().refreshTokenDet();
      }

      config.headers.Authorization = `Bearer ${token}`;
      return config;
    },
    (error) => {
      return Promise.reject(error);
    },
  );

  // 响应拦截器
  request.interceptors.response.use(
    (response: AxiosResponse) => {
      const { data } = response;

      // 这里可以根据后端的响应结构进行调整
      if (data.code !== 0) {
        message.error({
          content: data.message || data.msg || '请求失败',
          key: MessageKey,
        });
        return Promise.reject(new Error(data.message|| data.msg || '请求失败'));
      }

      // 业务成功（code === 0）才说明网络已恢复，自动隐藏网络异常横幅
      useNetStatusStore.getState().clear();

      return data.data;
    },
    (error) => {
      if (!error) return;
      // 处理 HTTP 错误状态
      if (error.response) {
        switch (error.response.status) {
          case 401:
            message.error({
              content: '未授权，请重新登录',
              key: MessageKey,
            });
            // 可以在这里处理登出逻辑
            setTimeout(() => useUserStore.getState().logout(), 500);
            break;
          case 403:
            message.error({
              key: MessageKey,
              content: '拒绝访问',
            });
            setTimeout(() => useUserStore.getState().logout(), 500);
            break;
          case 404:
            message.error({
              key: MessageKey,
              content: '请求错误，未找到该资源',
            });
            break;
          case 500:
            message.error({
              key: MessageKey,
              content: '服务器错误',
            });
            break;
          default:
            message.error({
              key: MessageKey,
              content: `连接错误 ${error.response.status}`,
            });
        }
      } else {
        // 非侵入式网络异常提示：只点亮顶部轻量横幅，不再弹阻塞式 Toast
        useNetStatusStore.getState().markOffline();
      }
      return Promise.reject(error);
    },
  );

  // 封装通用请求方法
  const http = {
    get<T = any>(url: string, config?: ProjectAxiosRequestConfig): Promise<T> {
      return request.get(url, config) as Promise<T>;
    },

    post<T = any>(
      url: string,
      data?: any,
      config?: ProjectAxiosRequestConfig,
    ): Promise<T> {
      return request.post(url, data, config) as Promise<T>;
    },

    put<T = any>(
      url: string,
      data?: any,
      config?: ProjectAxiosRequestConfig,
    ): Promise<T> {
      return request.put(url, data, config) as Promise<T>;
    },

    delete<T = any>(
      url: string,
      config?: ProjectAxiosRequestConfig,
    ): Promise<T> {
      return request.delete(url, config) as Promise<T>;
    },
  };

  return http;
};

// 后端地址运行时配置优先（主进程经 preload 注入），
// 打包环境未定义 VITE_APP_URL 时回退到本地 8080 网关，避免请求打到错误地址。
const injectedBackendBase =
  typeof window !== 'undefined' ? (window as any).__BACKEND_BASE_URL__ : undefined;
const appBase =
  injectedBackendBase || import.meta.env.VITE_APP_URL || 'http://127.0.0.1:8080/api';

export const http = getAxiosRequest(appBase);
export const hotHttp = getAxiosRequest(import.meta.env.VITE_APP_HOT_URL || appBase);

export default http;
