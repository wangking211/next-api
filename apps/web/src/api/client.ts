import axios from 'axios';
import { queryClient } from './queryClient';

export const TOKEN_KEY = 'aigw_token';

/** 会话过期标记：401 强制跳登录前写入，登录页读一次即清（用于提示“登录已过期”） */
export const SESSION_EXPIRED_KEY = 'aigw_session_expired';

/** 无需登录即可访问的公开路由：这些页面遇到 401 只清理本地状态，不跳登录页 */
const PUBLIC_PATHS = new Set(['/', '/login']);

export { errorMessage, httpStatus } from './errorMessage';

export function loginPathWithRedirect(pathname: string, search = ''): string {
  const target = `${pathname}${search}`;
  // 只接受站内绝对路径，防止开放重定向
  const safe = target.startsWith('/') && !target.startsWith('//') ? target : '';
  return safe ? `/login?redirect=${encodeURIComponent(safe)}` : '/login';
}

/** 读取并清除「会话过期」标记；登录页挂载时调用一次 */
export function consumeSessionExpired(): boolean {
  try {
    const flagged = sessionStorage.getItem(SESSION_EXPIRED_KEY) === '1';
    if (flagged) sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    return flagged;
  } catch {
    // 隐私模式 / 禁用存储：退化为无提示
    return false;
  }
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
      // 只有「带着令牌却被拒」才算过期；未登录访问公开接口不算
      const hadToken = !!localStorage.getItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
      // 清空缓存，避免上一个用户的缓存数据泄露到下一次登录
      queryClient.clear();
      const { pathname, search } = window.location;
      if (!PUBLIC_PATHS.has(pathname)) {
        if (hadToken) {
          try {
            sessionStorage.setItem(SESSION_EXPIRED_KEY, '1');
          } catch {
            /* 存储不可用：忽略提示 */
          }
        }
        window.location.href = loginPathWithRedirect(pathname, search);
      }
    }
    return Promise.reject(error);
  },
);
