/** 上游探针的报文处理工具（渠道页测试与 Key 测试共用，统一脱敏） */
import { redactSecrets } from '../../common/redact.util';

function rawUpstreamError(body: any, fallback: string): string {
  if (body == null) return fallback;
  if (typeof body === 'string') return body.slice(0, 1000) || fallback;
  const err = body.error;
  if (typeof err === 'string') return err;
  if (err?.message) return String(err.message);
  if (body.message) return String(body.message);
  if (body.msg) return String(body.msg);
  if (body.detail) {
    return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
  }
  try {
    return JSON.stringify(body).slice(0, 1000);
  } catch {
    return fallback;
  }
}

export function safeStringify(value: any): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 2000);
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return null;
  }
}

/** 控制台出口统一脱敏：上游报错可能回显完整密钥（实测 TokenFleet MiniMax-M2.5 回 sk-e280…） */
export function extractUpstreamError(body: any, fallback: string): string {
  return redactSecrets(rawUpstreamError(body, fallback));
}

export function redactDetail(value: string | null): string | null {
  return value == null ? null : redactSecrets(value);
}
