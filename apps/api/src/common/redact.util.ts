/**
 * 凭据脱敏。
 *
 * 上游报错经常原样回显密钥（实测 TokenFleet.cn 对 MiniMax-M2.5 会回
 * `{"code":401,"msg":"token 无效：sk-e280…"}`）。这类文案一旦原样入库或回传，
 * 等于把渠道主的密钥泄露给调用方、管理员和看日志的人。
 *
 * 因此在「落库」与「回传客户端」两个出口统一抹一遍：
 * - Channel.lastErrorMsg / RequestLog.errorMessage（存储）
 * - 上游错误透传文案（响应体）
 *
 * 只做保守替换（明确的密钥形态），避免误伤正常文本。
 */
const PATTERNS: Array<[RegExp, string]> = [
  // OpenAI / 中转平台常见前缀
  [/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***'],
  [/sk_[A-Za-z0-9_-]{6,}/g, 'sk_***'],
  [/\bBearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***'],
  // key=value 形态（api_key / apikey / access_token / secret / password）
  [
    /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password)["'\s:=]{1,4})[A-Za-z0-9._\-+/=]{6,}/gi,
    '$1***',
  ],
  // 长 hex 串（≥40）：多半是密钥/签名
  [/\b[A-Fa-f0-9]{40,}\b/g, '***'],
];

export function redactSecrets(input: unknown): string {
  const text = typeof input === 'string' ? input : String(input ?? '');
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}
