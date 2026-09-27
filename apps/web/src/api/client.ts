import axios from 'axios';
import { queryClient } from './queryClient';

export const TOKEN_KEY = 'aigw_token';

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
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
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
