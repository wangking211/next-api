/** 上游错误提取与分类（纯函数）：消息脱敏 + 限流/拒答/模型无权访问特征判定（执行内核与各执行器共用） */
import { redactSecrets } from '../common/redact.util';
import type { UpstreamError } from './types';

/** 仅提取上游错误消息，避免把上游原始错误体（可能含内部细节）原样透传给客户端 */
export function upstreamErrorMessage(e: UpstreamError): string {
  const body = e.body;
  const msg =
    (typeof body?.error?.message === 'string' && body.error.message) ||
    (typeof body?.message === 'string' && body.message) ||
    e.message;
  // 上游文案里常混着渠道密钥（如 `token 无效：sk-...`）→ 回传前统一脱敏
  return redactSecrets(String(msg)).slice(0, 500);
}

/** 上游错误的可判定文本：message + code + type（UpstreamError.message 只有 "Upstream error 429"，语义在 body 里） */
export function upstreamErrorSignal(e: UpstreamError): string {
  const body = e.body;
  const parts = [
    typeof body?.error?.message === 'string' ? body.error.message : '',
    typeof body?.error?.code === 'string' ? body.error.code : '',
    typeof body?.error?.type === 'string' ? body.error.type : '',
    typeof body?.message === 'string' ? body.message : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/** 配额/限流特征：429，或 4xx 错误文本命中限额语义（订阅号日限额常见 400/403 + quota 文案） */
const QUOTA_RE =
  /(insufficient[_\s-]?quota|rate[_\s-]?limit|too many requests|quota|usage.{0,15}(limit|exceed)|daily.{0,15}(limit|quota)|limit.{0,20}(exceed|exhaust|reach|hit)|exceeded.{0,15}(limit|quota)|请求过于频繁|超出.{0,8}(限额|限制|配额)|限流|配额)/i;

export function isRateLimited(e: UpstreamError): boolean {
  if (e.status === 429) return true;
  if (e.status < 400 || e.status >= 500) return false;
  return QUOTA_RE.test(upstreamErrorSignal(e));
}

/** 拒答/内容过滤特征：用户内容被安全策略拒绝，只降质量分，不伤稳定性也不熔断 */
const REFUSAL_RE =
  /(content[_\s-]?filter|content_policy|safety|refusal|refused|内容安全|敏感内容)/i;

export function isRefusal(e: UpstreamError): boolean {
  return REFUSAL_RE.test(upstreamErrorSignal(e));
}

/**
 * 上游「令牌无权访问该模型」特征（new-api 分组未开通等）：属配置问题，
 * 应换下一家上游试（可能别家有权限），并返回明确的 model_not_found，
 * 且只冷却「该渠道 × 该模型」，不误禁整条渠道。
 */
const MODEL_ACCESS_RE =
  /(no access to model|model[_\s-]?not[_\s-]?found|not have access|no permission|permission denied|not authorized|unsupported model|无权访问|没有权限|无权限|未开通|权限不足)/i;

export function isModelAccessDenied(e: UpstreamError): boolean {
  if (e.status !== 403 && e.status !== 404) return false;
  return MODEL_ACCESS_RE.test(upstreamErrorSignal(e));
}

