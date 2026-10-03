import i18n from '../i18n';

/**
 * 后端错误码 → 本地化文案键。
 *
 * 控制台接口的错误统一带稳定 code（message 保留后端原文，供 API 消费者与日志使用），
 * 这里按界面语言换成对应文案——后端文案中英混写，直接回显就会「中文界面看到英文、
 * 英文界面看到中文」。语义等价的 code 允许指向同一键（如三种令牌失效都落 api.unauthorized）。
 * 未收录的 code 回退到后端 message，不会比改造前更差。
 */
const ERROR_CODE_KEYS = {
  // —— 鉴权 / 会话 ——
  AUTH_INVALID_CREDENTIALS: 'api.authInvalidCredentials',
  AUTH_ACCOUNT_BANNED: 'api.authAccountBanned',
  AUTH_TOO_MANY_ATTEMPTS: 'auth.login.errorTooManyAttempts',
  AUTH_IP_THROTTLED: 'api.authIpThrottled',
  AUTH_EMAIL_TAKEN: 'api.authEmailTaken',
  AUTH_USERNAME_TAKEN: 'api.authUsernameTaken',
  AUTH_IDENTIFIER_TAKEN: 'api.authIdentifierTaken',
  AUTH_TOKEN_MISSING: 'api.unauthorized',
  AUTH_TOKEN_INVALID: 'api.unauthorized',
  AUTH_TOKEN_REVOKED: 'err.auth.tokenRevoked',
  FORBIDDEN_INSUFFICIENT_PERMISSIONS: 'api.forbidden',
  // —— 代理 ——
  AGENT_EMAIL_TAKEN: 'api.authEmailTaken',
  AGENT_USERNAME_TAKEN: 'api.authUsernameTaken',
  AGENT_AMOUNT_POSITIVE: 'err.amount.positive',
  AGENT_MEMBER_NOT_FOUND: 'err.agent.memberNotFound',
  AGENT_NOT_FOUND: 'err.agent.notFound',
  AGENT_BALANCE_INSUFFICIENT: 'err.agent.balanceInsufficient',
  // —— 账户 / 余额 / 兑换码 ——
  USER_NOT_FOUND: 'err.user.notFound',
  BALANCE_INSUFFICIENT: 'err.balance.insufficient',
  BILLING_AMOUNT_NON_ZERO: 'err.amount.nonZero',
  REDEEM_CODE_NOT_FOUND: 'err.redeem.notFound',
  REDEEM_CODE_REQUIRED: 'err.redeem.required',
  REDEEM_CODE_INVALID: 'err.redeem.invalid',
  REDEEM_CODE_USED: 'err.redeem.used',
  REDEEM_CODE_REVOKED: 'err.redeem.revoked',
  REDEEM_CODE_EXPIRED: 'err.redeem.expired',
  REDEEM_CODE_REVOKE_USED: 'err.redeem.revokeUsed',
  BILLING_EXCHANGE_RATE_UNAVAILABLE: 'err.exchangeRate.unavailable',
  // —— 支付 / 提现 ——
  PAYMENT_NOT_ENABLED: 'err.payment.notEnabled',
  PAYMENT_METHOD_UNSUPPORTED: 'err.payment.methodUnsupported',
  PAYMENT_GATEWAY_UNREACHABLE: 'err.payment.gatewayUnreachable',
  PAYMENT_ORDER_CREATE_FAILED: 'err.payment.orderCreateFailed',
  PAYMENT_ORDER_NOT_FOUND: 'err.payment.orderNotFound',
  PAYMENT_SIGNATURE_INVALID: 'err.payment.signatureInvalid',
  WITHDRAW_AMOUNT_POSITIVE: 'err.amount.positive',
  WITHDRAW_NOT_FOUND: 'err.withdraw.notFound',
  WITHDRAW_ALREADY_PROCESSED: 'err.withdraw.processed',
  // —— 渠道 ——
  CHANNEL_NOT_FOUND: 'err.channel.notFound',
  CHANNEL_PLATFORM_ADMIN_ONLY: 'err.channel.platformAdminOnly',
  CHANNEL_KEY_UNREADABLE: 'err.channel.keyUnreadable',
  CHANNEL_STORED_KEY_UNREADABLE: 'err.channel.storedKeyUnreadable',
  CHANNEL_UPSTREAM_KEY_REQUIRED: 'err.channel.upstreamKeyRequired',
  CHANNEL_BASE_URL_REQUIRED: 'err.channel.baseUrlRequired',
  CHANNEL_BASE_URL_UNSAFE: 'err.channel.baseUrlUnsafe',
  CHANNEL_UPSTREAM_UNREACHABLE: 'err.channel.upstreamUnreachable',
  CHANNEL_MODEL_LIST_FETCH_FAILED: 'err.channel.modelListFetchFailed',
  CHANNEL_MODEL_LIST_NOT_FOUND: 'err.channel.modelListNotFound',
  CHANNEL_MODEL_LIST_INVALID_JSON: 'err.channel.modelListInvalidJson',
  CHANNEL_MODEL_LIST_EMPTY: 'err.channel.modelListEmpty',
  CHANNEL_UPSTREAM_ERROR: 'err.channel.upstreamError',
  CHANNEL_TEST_MODEL_REQUIRED: 'err.channel.testModelRequired',
  CHANNEL_GROUP_INVALID: 'err.channel.groupInvalid',
  // —— 分组 / 模型 / 密钥 ——
  GROUP_IDENTIFIER_EXISTS: 'err.group.identifierExists',
  GROUP_NOT_FOUND: 'err.group.notFound',
  GROUP_DEFAULT_UNREMOVABLE: 'err.group.defaultUnremovable',
  MODEL_NOT_FOUND: 'err.model.notFound',
  API_KEY_NOT_FOUND: 'err.key.notFound',
  // —— 上游地址安全校验（SSRF）——
  URL_UNSAFE_INVALID_URL: 'err.url.invalid',
  URL_UNSAFE_SCHEME: 'err.url.scheme',
  URL_UNSAFE_NO_HOST: 'err.url.noHost',
  URL_UNSAFE_INTERNAL_HOST: 'err.url.internalHost',
  URL_UNSAFE_PRIVATE_ADDRESS: 'err.url.privateAddress',
  URL_UNSAFE_DNS_FAILED: 'err.url.dnsFailed',
  URL_UNSAFE_RESOLVED_PRIVATE: 'err.url.resolvedPrivate',
  URL_UNSAFE_REDIRECT_UNPARSEABLE: 'err.url.redirectUnparseable',
  URL_UNSAFE_REDIRECT_LIMIT: 'err.url.redirectLimit',
} as const;

/**
 * 异常 → 可展示文案。
 *
 * 优先级：后端错误码（本地化，details 作为插值参数）> 后端返回的 message（数组取前若干条拼接）
 * > 后端 error.message > 按 HTTP 状态本地化兜底。
 * 只有服务端既没给 code 也没给 message（网关层错误、代理 5xx、连接中断）时才用状态码映射，
 * 避免前端直接抛英文技术文案。
 */
export function errorMessage(error: unknown): string {
  const anyErr = error as any;
  const data = anyErr?.response?.data;
  if (typeof data?.code === 'string' && data.code in ERROR_CODE_KEYS) {
    const key = ERROR_CODE_KEYS[data.code as keyof typeof ERROR_CODE_KEYS];
    // 动态文案（「下单失败（404）」「上游返回 500」等）由后端 details 提供插值参数
    const details = data.details && typeof data.details === 'object' ? data.details : undefined;
    return details ? i18n.t(key, details) : i18n.t(key);
  }
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
