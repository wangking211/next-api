import axios from 'axios';
import { queryClient } from './queryClient';

export const TOKEN_KEY = 'aigw_token';

/** 无需登录即可访问的公开路由：这些页面遇到 401 只清理本地状态，不跳登录页 */
const PUBLIC_PATHS = new Set(['/', '/login']);

export function loginPathWithRedirect(pathname: string, search = ''): string {
  const target = `${pathname}${search}`;
  // 只接受站内绝对路径，防止开放重定向
  const safe = target.startsWith('/') && !target.startsWith('//') ? target : '';
  return safe ? `/login?redirect=${encodeURIComponent(safe)}` : '/login';
}

export const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error?.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      // 清空缓存，避免上一个用户的缓存数据泄露到下一次登录
      queryClient.clear();
      const { pathname, search } = window.location;
      if (!PUBLIC_PATHS.has(pathname)) {
        window.location.href = loginPathWithRedirect(pathname, search);
      }
    }
    return Promise.reject(error);
  },
);

export function errorMessage(error: unknown): string {
  const anyErr = error as any;
  const data = anyErr?.response?.data;
  if (typeof data?.message === 'string') return data.message;
  if (Array.isArray(data?.message)) return data.message.join(', ');
  if (typeof data?.error?.message === 'string') return data.error.message;
  return anyErr?.message ?? '请求失败';
}
