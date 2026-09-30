import i18n from '../i18n';

/**
 * 异常 → 可展示文案。
 *
 * 优先级：后端返回的 message（数组取前若干条拼接）> 后端 error.message > 按 HTTP 状态本地化兜底。
 * 后端有明确文案时一定用它（例如「余额不足」「渠道密钥无效」这类上下文只有服务端知道）；
 * 只有服务端没给 message（网关层错误、代理 5xx、连接中断）时才用状态码映射，避免前端直接抛英文技术文案。
 */
export function errorMessage(error: unknown): string {
  const anyErr = error as any;
  const data = anyErr?.response?.data;
  if (typeof data?.message === 'string' && data.message) return data.message;
  if (Array.isArray(data?.message) && data.message.length > 0) {
    return data.message.map(String).join(', ');
  }
  if (typeof data?.error?.message === 'string' && data.error.message) {
    return data.error.message;
  }

  const status = httpStatus(error);
  if (status === 401) return i18n.t('api.unauthorized');
  if (status === 403) return i18n.t('api.forbidden');
  if (status === 404) return i18n.t('api.notFound');
  if (status === 429) return i18n.t('api.tooManyRequests');
  if (status != null && status >= 500) return i18n.t('api.serverError');

  // 请求根本没到服务端（断网 / DNS / 跨域被拦 / 超时）
  if (anyErr?.code === 'ERR_NETWORK' || anyErr?.code === 'ECONNABORTED') {
    return i18n.t('api.networkError');
  }
  return typeof anyErr?.message === 'string' && anyErr.message
    ? anyErr.message
    : i18n.t('api.requestFailed');
}

/** HTTP 状态码；无响应（网络层失败）时返回 undefined */
export function httpStatus(error: unknown): number | undefined {
  const status = (error as any)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}
