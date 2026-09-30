/**
 * Anthropic Messages API 双向转换（入站：客户端 Anthropic 协议 → 内部 OpenAI 协议；
 * 出站：内部 OpenAI 响应/SSE → Anthropic 响应/SSE）。
 *
 * 网关内部统一走 OpenAI 协议（provider 层负责对上游再做协议适配），
 * 因此这里只需要在 /v1/messages 边界做一次转换。
 */

// ---------------------------------------------------------------------------
// 入站：Anthropic 请求 → OpenAI 请求
// ---------------------------------------------------------------------------

function systemToText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => String(b.text ?? ''))
      .join('\n');
  }
  return '';
}

function imageSourceToUrl(source: any): string {
  if (source?.type === 'base64' && source.data) {
    return `data:${source.media_type ?? 'image/png'};base64,${source.data}`;
  }
  if (source?.type === 'url' && source.url) return String(source.url);
  return '';
}

/** Anthropic content block → OpenAI content part */
function contentPart(block: any): Record<string, any> | null {
  if (typeof block === 'string') return { type: 'text', text: block };
  if (block?.type === 'text') return { type: 'text', text: String(block.text ?? '') };
  if (block?.type === 'image') {
    const url = imageSourceToUrl(block.source);
    return url ? { type: 'image_url', image_url: { url } } : null;
  }
  // thinking 等内部块无 OpenAI 等价物，忽略；未知块降级为文本避免丢失信息
  if (block?.type === 'thinking' || block?.type === 'redacted_thinking') return null;
  if (block?.type === 'tool_use' || block?.type === 'tool_result') return null;
  return { type: 'text', text: JSON.stringify(block) };
}

/** tool_result.content（string 或块数组）→ OpenAI tool 消息文本 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === 'string') parts.push(b);
      else if (b?.type === 'text') parts.push(String(b.text ?? ''));
      else if (b?.type === 'image') parts.push('[image]');
      else if (b) parts.push(JSON.stringify(b));
    }
    return parts.join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

export function anthropicToOpenAiRequest(body: Record<string, any>): Record<string, any> {
  const messages: any[] = [];

  const system = systemToText(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const m of body.messages ?? []) {
    const raw = m.content;
    const blocks: any[] =
      typeof raw === 'string'
        ? [{ type: 'text', text: raw }]
        : Array.isArray(raw)
          ? raw
          : [];

    // Anthropic 把 tool 结果放在下一条 user 消息里；OpenAI 需要独立的 tool 角色消息
    const toolResults = blocks.filter((b) => b?.type === 'tool_result');
    for (const tr of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: toolResultText(tr.content),
      });
    }

    if (m.role === 'assistant') {
      const text = blocks
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('');
      const toolCalls = blocks
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg: any = {
        role: 'assistant',
        content: text || (toolCalls.length ? null : ''),
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      const parts = blocks
        .filter((b) => b?.type !== 'tool_result')
        .map((b) => contentPart(b))
        .filter((p): p is Record<string, any> => p !== null);
      if (parts.length === 1 && parts[0].type === 'text') {
        messages.push({ role: 'user', content: parts[0].text });
      } else if (parts.length > 1 || (parts.length === 1 && parts[0].type !== 'text')) {
        messages.push({ role: 'user', content: parts });
      }
    }
  }

  const out: Record<string, any> = {
    model: body.model,
    max_tokens: body.max_tokens,
    messages,
  };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  // top_k 为 Anthropic 特有参数，OpenAI 上游不支持，丢弃
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    out.stop = body.stop_sequences;
  }
  if (body.stream != null) out.stream = body.stream;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: any) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
  }

  const tc = body.tool_choice;
  if (tc) {
    if (typeof tc === 'string') out.tool_choice = tc;
    else if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) {
      out.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 出站：OpenAI 响应 → Anthropic 响应
// ---------------------------------------------------------------------------

function finishToStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    case 'stop':
    case null:
    case undefined:
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

export function openAiToAnthropicResponse(openai: any, model: string) {
  const choice = openai?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: any[] = [];
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls ?? []) {
    let input: any;
    try {
      input = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: tc.id ?? `toolu_${String(Math.random()).slice(2, 14)}`,
      name: tc.function?.name,
      input,
    });
  }

  const usage = openai?.usage ?? {};
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const rawId = String(openai?.id ?? '');
  return {
    id: rawId.replace(/^chatcmpl-/, 'msg_') || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: openai?.model ?? model,
    content,
    stop_reason: finishToStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: prompt,
      output_tokens: completion,
      ...(usage.cache_read_tokens
        ? { cache_read_input_tokens: usage.cache_read_tokens }
        : {}),
      ...(usage.cache_write_tokens
        ? { cache_creation_input_tokens: usage.cache_write_tokens }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 出站：错误体
// ---------------------------------------------------------------------------

const ANTHROPIC_ERROR_TYPES: Record<string, string> = {
  invalid_request_error: 'invalid_request_error',
  authentication_error: 'authentication_error',
  permission_error: 'permission_error',
  model_not_found: 'not_found_error',
  not_found_error: 'not_found_error',
  rate_limit_error: 'rate_limit_error',
  insufficient_quota: 'permission_error',
  upstream_error: 'api_error',
  api_error: 'api_error',
};

export function toAnthropicErrorBody(
  message: string,
  openaiType = 'invalid_request_error',
): { type: 'error'; error: { type: string; message: string } } {
  return {
    type: 'error',
    error: {
      type: ANTHROPIC_ERROR_TYPES[openaiType] ?? 'api_error',
      message,
    },
  };
}

// ---------------------------------------------------------------------------
// 出站：OpenAI SSE → Anthropic SSE 流式翻译
// ---------------------------------------------------------------------------

function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface ToolBlockBuf {
  id: string;
  name: string;
  args: string;
  started: boolean;
  blockIdx: number;
}

/**
 * 将 OpenAI 格式的 chat.completion.chunk 翻译为 Anthropic Messages 流事件。
 * 用法：逐块 push() 收集要写出的 SSE 文本，流结束后调用 flush() 收尾。
 * 事件顺序：message_start → (content_block_start/delta/stop)* → message_delta → message_stop。
 */
export class AnthropicStreamTranslator {
  private buffer = '';
  private readonly msgId: string;
  private started = false;
  private finished = false;
  private blockOpen = false;
  private openIndex = 0;
  private blockIdx = 0;
  private finishReason: string | null = null;
  private outputText = '';
  private finalUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  private readonly toolBuf = new Map<number, ToolBlockBuf>();

  constructor(
    private readonly model: string,
    private readonly inputTokensEstimate: number,
  ) {
    this.msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /** 立即发出 message_start（流开始时调用，让客户端尽早收到首事件） */
  begin(): string[] {
    const events: string[] = [];
    this.ensureStarted(events);
    return events;
  }

  push(chunk: string): string[] {
    const events: string[] = [];
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.handleBlock(block, events);
    }
    return events;
  }

  /**
   * 流结束收尾。errorMessage 存在时发出 error 事件并终止（Anthropic 协议允许
   * 在任意时刻发送 error 事件，此后不再有 message_stop）。
   */
  flush(errorMessage?: string): string[] {
    const events: string[] = [];
    // 处理缓冲区残留（上游未以空行结束的尾块）
    if (this.buffer.trim()) {
      this.handleBlock(this.buffer, events);
      this.buffer = '';
    }
    if (this.finished) return events;
    if (errorMessage) {
      this.ensureStarted(events);
      events.push(
        sse('error', {
          type: 'error',
          error: { type: 'api_error', message: errorMessage.slice(0, 500) },
        }),
      );
      this.finished = true;
      return events;
    }
    this.finish(events);
    return events;
  }

  private ensureStarted(events: string[]): void {
    if (this.started) return;
    this.started = true;
    events.push(
      sse('message_start', {
        message: {
          id: this.msgId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokensEstimate, output_tokens: 0 },
        },
      }),
    );
  }

  private closeBlock(events: string[]): void {
    if (!this.blockOpen) return;
    events.push(sse('content_block_stop', { index: this.openIndex }));
    this.blockOpen = false;
  }

  private startTextBlock(events: string[]): void {
    this.closeBlock(events);
    this.openIndex = this.blockIdx++;
    events.push(
      sse('content_block_start', {
        index: this.openIndex,
        content_block: { type: 'text', text: '' },
      }),
    );
    this.blockOpen = true;
  }

  private handleToolCall(tc: any, events: string[]): void {
    const oi = typeof tc.index === 'number' ? tc.index : 0;
    let t = this.toolBuf.get(oi);
    if (!t) {
      t = {
        id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 14)}`,
        name: '',
        args: '',
        started: false,
        blockIdx: -1,
      };
      this.toolBuf.set(oi, t);
    }
    if (tc.id) t.id = tc.id;
    if (tc.function?.name && !t.name) t.name = tc.function.name;
    const frag: string = tc.function?.arguments ?? '';

    if (!t.started) {
      // id/name 与参数可能分片到达；等 name 就绪后一次性开块
      t.args += frag;
      if (t.name) {
        this.ensureStarted(events);
        this.closeBlock(events);
        t.blockIdx = this.blockIdx++;
        events.push(
          sse('content_block_start', {
            index: t.blockIdx,
            content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} },
          }),
        );
        this.blockOpen = true;
        this.openIndex = t.blockIdx;
        if (t.args) {
          events.push(
            sse('content_block_delta', {
              index: t.blockIdx,
              delta: { type: 'input_json_delta', partial_json: t.args },
            }),
          );
        }
        t.started = true;
        t.args = '';
      }
    } else if (frag) {
      events.push(
        sse('content_block_delta', {
          index: t.blockIdx,
          delta: { type: 'input_json_delta', partial_json: frag },
        }),
      );
    }
  }

  private handleData(data: any, events: string[]): void {
    if (data?.usage) this.finalUsage = data.usage;
    const choice = data?.choices?.[0];
    if (!choice) return; // 仅携带 usage 的尾块
    this.ensureStarted(events);

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (!this.blockOpen) this.startTextBlock(events);
      this.outputText += delta.content;
      events.push(
        sse('content_block_delta', {
          index: this.openIndex,
          delta: { type: 'text_delta', text: delta.content },
        }),
      );
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) this.handleToolCall(tc, events);
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  private handleBlock(block: string, events: string[]): void {
    for (const line of block.split('\n')) {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        this.finish(events);
        continue;
      }
      try {
        this.handleData(JSON.parse(payload), events);
      } catch {
        // 忽略无法解析的分片
      }
    }
  }

  private finish(events: string[]): void {
    if (this.finished) return;
    this.ensureStarted(events);
    // 未拿到 name 的残缺 tool 分片：以占位名冲刷，避免客户端悬挂
    for (const t of this.toolBuf.values()) {
      if (t.started) continue;
      if (!t.name) t.name = 'unknown_tool';
      const buf = t.args;
      t.args = '';
      t.started = true;
      this.closeBlock(events);
      t.blockIdx = this.blockIdx++;
      events.push(
        sse('content_block_start', {
          index: t.blockIdx,
          content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} },
        }),
      );
      this.blockOpen = true;
      this.openIndex = t.blockIdx;
      if (buf) {
        events.push(
          sse('content_block_delta', {
            index: t.blockIdx,
            delta: { type: 'input_json_delta', partial_json: buf },
          }),
        );
      }
    }
    this.closeBlock(events);
    const outputTokens =
      this.finalUsage?.completion_tokens ?? Math.ceil(this.outputText.length / 4);
    events.push(
      sse('message_delta', {
        delta: {
          stop_reason: finishToStopReason(this.finishReason),
          stop_sequence: null,
        },
        usage: { output_tokens: outputTokens },
      }),
    );
    events.push(sse('message_stop', {}));
    this.finished = true;
  }
}
