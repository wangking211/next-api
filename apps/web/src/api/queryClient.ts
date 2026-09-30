import { MutationCache, QueryClient } from '@tanstack/react-query';
import { errorMessage } from './errorMessage';
import { notifyError } from './notify';

/** 全局 QueryClient：合理默认值，避免导航即刷新与对 4xx 的无意义重试 */
export const queryClient = new QueryClient({
  /**
   * 统一的 mutation 失败提示：24 处页面原本各写一份 `onError: (e) => message.error(errorMessage(e))`，
   * 现在只在「需要额外副作用」（关弹窗、回滚表单、局部内联报错）时才写 per-mutation onError。
   * 想完全不弹（例如登录框在表单内联展示错误）传 `meta: { silentError: true }`。
   */
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silentError) return;
      notifyError(errorMessage(error));
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        const status = (error as any)?.response?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: 0,
    },
  },
});
