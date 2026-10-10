/** 上游错误提取与分类（纯函数）：消息脱敏 + 限流/拒答/模型无权访问特征判定（执行内核与各执行器共用） */
import { redactSecrets } from '../common/redact.util';
import { UpstreamError } from './types';

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

/** 上游失败分类结果（handleUpstreamFailure 与流式中断记录共用一套口径） */
export interface FailureClass {
  /** 限流/超限：冷却退避，不累计渠道失败 */
  limited: boolean;
  /** 可重试故障（5xx / 网络中断）：累计渠道失败与 (渠道,模型) 熔断 */
  transient: boolean;
  /** 上游鉴权失效（401）：只降路由质量指标 */
  authFault: boolean;
  /** 无权访问该模型（403/404 特征）：只冷却该 (渠道,模型) 组合 */
  modelDenied: boolean;
  /** 拒答/内容过滤：只降质量分；文案特征优先于状态码（5xx+拒答文案不计渠道失败） */
  refusal: boolean;
  /** 可判定错误文本：UpstreamError 取 message+code+type，普通 Error 取 message */
  signal: string;
  /** 上游状态码；非 UpstreamError 为 undefined */
  status?: number;
  /** 上游 Retry-After（毫秒），仅限流路径有意义 */
  retryAfterMs?: number;
}

/**
 * 上游失败分类（纯函数，无 IO）：一次判定供故障转移、健康度与路由指标共用。
 * 优先级：限流 > 鉴权失效 > 模型无权 > 拒答 > 可重试故障——
 * 拒答文案特征压过状态码，防止「503 + content_policy 文案」被当成普通故障
 * 累计 failureCount 打死渠道（拒答只降质量分，且可转移到下一家上游再试）。
 */
export function classifyUpstreamFailure(e: unknown): FailureClass {
  const ue = e instanceof UpstreamError ? e : null;
  const status = ue?.status;
  const signal =
    (ue && upstreamErrorSignal(ue)) || String((e as Error)?.message ?? '') || 'upstream error';
  const limited = ue ? isRateLimited(ue) : false;
  const authFault = !!ue && !limited && status === 401;
  const modelDenied = !!ue && !limited && !authFault && isModelAccessDenied(ue);
  const refusal = !limited && !authFault && !modelDenied && !!ue && isRefusal(ue);
  // 普通 Error（网络中断/解码失败）与未命中任何特征的 UpstreamError 按可重试故障处理
  const transient = !limited && !refusal && (!ue || ue.retryable);
  return {
    limited,
    transient,
    authFault,
    modelDenied,
    refusal,
    signal,
    status,
    retryAfterMs: ue?.retryAfterMs,
  };
}

/**
 * 上游 Retry-After 头 → 毫秒（RFC 9110：delay-seconds 或 HTTP-date 两种形式）。
 * 既接受响应对象（从 headers 读 retry-after，兼容无 headers 的测试 mock），
 * 也接受裸头字符串。缺失 / 非法 / 已过期 / 非正值 → undefined（调用方回退自身退避）。
 */
export function parseRetryAfterMs(
  input: string | null | undefined | { headers?: { get(name: string): string | null } },
): number | undefined {
  const raw =
    typeof input === 'string' || input == null ? input : input.headers?.get('retry-after');
  if (!raw) return undefined;
  const v = String(raw).trim();
  if (!v) return undefined;
  // delay-seconds（允许小数，向上取整到毫秒）
  if (/^\d+(\.\d+)?$/.test(v)) {
    const sec = Number(v);
    return Number.isFinite(sec) && sec > 0 ? Math.ceil(sec * 1000) : undefined;
  }
  // HTTP-date：取与当前时刻的剩余差值，已过期视为未提供
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  const ms = at - Date.now();
  return ms > 0 ? ms : undefined;
}
