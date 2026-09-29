export interface SseEvent {
  event: string;
  data: string;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** 未显式指定时的上游默认总超时：非流式路径若上游挂起，必须有兜底上限 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

/**
 * 解析上游总超时：
 * - undefined → 默认 120s（非流式调用未传 timeoutMs 时的兜底，防止挂死且阻塞故障转移）
 * - 0        → 不设总超时（流式：改由空闲超时 + 客户端断开控制）
 * - >0       → 指定值
 */
export function resolveTimeoutMs(timeoutMs?: number): number {
  return timeoutMs === undefined ? DEFAULT_UPSTREAM_TIMEOUT_MS : timeoutMs;
}

/** 组合总超时与外部中止信号；语义见 resolveTimeoutMs */
export function combineSignals(
  timeoutMs: number | undefined,
  external?: AbortSignal,
): AbortSignal {
  const signals: AbortSignal[] = [];
  const effective = resolveTimeoutMs(timeoutMs);
  if (effective > 0) signals.push(AbortSignal.timeout(effective));
  if (external) signals.push(external);
  if (signals.length === 0) return AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS);
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/** 归纳 fetch 失败的具体原因（网络错误/超时/TLS 等） */
export function describeFetchError(e: any): string {
  const cause = e?.cause;
  const code = cause?.code ?? cause?.message;
  let msg = e?.message ?? 'fetch failed';
  if (code && !String(msg).includes(String(code))) msg += ` (${code})`;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    msg = 'request timeout';
  }
  return msg;
}

/** 解析上游 SSE 流，逐个产出事件（兼容 \n\n 与 \r\n\r\n 分隔） */
export async function* sseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      const sep = /\r?\n\r?\n/;
      while ((match = sep.exec(buffer)) !== null) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseSseBlock(raw);
        if (parsed) yield parsed;
      }
    }
    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(raw: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.startsWith('event:')) {
      event = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** 读取上游原始流并原样转发（OpenAI 兼容透传） */
export async function* pipeRaw(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
