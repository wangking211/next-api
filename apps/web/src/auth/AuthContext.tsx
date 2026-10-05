import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { TOKEN_KEY } from '../api/client';
import { queryClient } from '../api/queryClient';
import { authApi } from '../api/endpoints';
import type { UserInfo } from '../api/types';

interface AuthContextValue {
  user: UserInfo | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  /** emailCode 仅在服务端配置了 SMTP 时会被校验；未配置时可省略 */
  register: (
    email: string,
    username: string,
    password: string,
    emailCode?: string,
  ) => Promise<void>;
  logout: () => void;
  /** 退出全部设备：先吊销服务端全部令牌，再清理本地状态 */
  logoutAll: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setLoading(false);
      return;
    }
    authApi
      .me()
      .then(setUser)
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        queryClient.clear();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const data = await authApi.login(identifier, password);
    queryClient.clear();
    localStorage.setItem(TOKEN_KEY, data.accessToken);
    setUser(data.user);
  }, []);

  const register = useCallback(
    async (email: string, username: string, password: string, emailCode?: string) => {
      const data = await authApi.register(email, username, password, emailCode);
      queryClient.clear();
      localStorage.setItem(TOKEN_KEY, data.accessToken);
      setUser(data.user);
    },
    [],
  );

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    queryClient.clear();
    setUser(null);
  }, []);

  const logoutAll = useCallback(async () => {
    // 先吊销服务端全部令牌；失败也不阻断本地退出，避免卡在已失效的会话里
    await authApi.logoutAll().catch(() => undefined);
    localStorage.removeItem(TOKEN_KEY);
    queryClient.clear();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout, logoutAll }),
    [user, loading, login, register, logout, logoutAll],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
