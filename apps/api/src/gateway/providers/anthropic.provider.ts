import { Channel } from '@prisma/client';
import {
  ChatRequest,
  NonStreamResult,
  Provider,
  StreamResult,
  UpstreamError,
  UsageInfo,
} from '../types';
import { parseRetryAfterMs } from '../upstream-error.util';
import { joinUrl, sseEvents, describeFetchError, combineSignals } from './stream.util';

const ANTHROPIC_VERSION = '2023-06-01';

function toAnthropicContent(content: any): any {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const blocks: any[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
      continue;
    }
    if (part?.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part?.type === 'image_url') {
      const url: string = part.image_url?.url ?? '';
      const m = /^data:(.+?);base64,(.*)$/.exec(url);
      if (m) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: m[1], data: m[2] },
        });
      } else if (url) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    } else {
      blocks.push({ type: 'text', text: JSON.stringify(part) });
    }
  }
  return blocks;
}

export function buildAnthropicBody(req: ChatRequest): Record<string, any> {
  const body = req.body;
  const systemParts: string[] = [];
  const messages: any[] = [];
  for (const m of body.messages ?? []) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      continue;
    }
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: toAnthropicContent(m.content),
    });
  }
  const out: Record<string, any> = {
    model: req.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 1024,
    messages,
  };
  if (systemParts.length) out.system = systemParts.join('\n');
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop != null) {
    out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  return out;
}

function mapStopReason(reason?: string | null): string {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

export function toOpenAiResponse(anth: any, model: string) {
  const text = (anth.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  const inputTokens = anth.usage?.input_tokens ?? 0;
  const completion = anth.usage?.output_tokens ?? 0;
  const cacheRead = anth.usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = anth.usage?.cache_creation_input_tokens ?? 0;
  // Anthropic 的 input_tokens 不含缓存读/写；本项目统一按 OpenAI 口径计费
  // （prompt_tokens 含缓存），故这里把缓存部分补回，否则 usage.service 会再减一次
  // cacheRead，导致缓存命中时非缓存输入成本被少计（收入漏损）。
  const prompt = inputTokens + cacheRead + cacheWrite;
  return {
    id: anth.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anth.model ?? model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: mapStopReason(anth.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    },
  };
}

function chunkLine(
  id: string,
  model: string,
  created: number,
  delta: Record<string, any>,
  finish: string | null,
): string {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly aliases = ['anthropic', 'claude'];

  private headers(apiKey: string) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  private async request(
    channel: Channel,
    apiKey: string,
    body: Record<string, any>,
    stream: boolean,
    timeoutMs = 120000,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = joinUrl(channel.baseUrl, 'messages');
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          ...this.headers(apiKey),
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(stream ? { ...body, stream: true } : body),
        redirect: 'manual',
        signal: combineSignals(timeoutMs, signal),
      });
    } catch (e: any) {
      throw new UpstreamError(`Upstream connection failed: ${describeFetchError(e)}`, 502, true);
    }
  }

  async chatNonStream(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<NonStreamResult> {
    const res = await this.request(
      channel,
      apiKey,
      buildAnthropicBody(req),
      false,
      req.timeoutMs,
      req.signal,
    );
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: { message: text || 'Invalid upstream response', type: 'upstream_error' } };
    }
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw new UpstreamError(
        `Upstream error ${res.status}`,
        res.status,
        retryable,
        json,
        parseRetryAfterMs(res),
      );
    }
    const openai = toOpenAiResponse(json, req.model);
    return {
      status: 200,
      json: openai,
      usage: {
        promptTokens: openai.usage.prompt_tokens,
        completionTokens: openai.usage.completion_tokens,
        totalTokens: openai.usage.total_tokens,
        cacheReadTokens: (openai.usage as any).cache_read_tokens ?? 0,
        cacheWriteTokens: (openai.usage as any).cache_write_tokens ?? 0,
      },
      rawText: JSON.stringify(openai),
    };
  }

  async chatStream(channel: Channel, apiKey: string, req: ChatRequest): Promise<StreamResult> {
    const res = await this.request(
      channel,
      apiKey,
      buildAnthropicBody(req),
      true,
      req.timeoutMs,
      req.signal,
    );
    if (!res.ok) {
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: { message: text, type: 'upstream_error' } };
      }
      const retryable = res.status >= 500 || res.status === 429;
      throw new UpstreamError(
        `Upstream error ${res.status}`,
        res.status,
        retryable,
        json,
        parseRetryAfterMs(res),
      );
    }
    if (!res.body) {
      throw new UpstreamError('Upstream returned empty stream', 502, true);
    }
    const usageRef: { usage?: UsageInfo } = {};
    return {
      status: 200,
      chunks: this.translateStream(res.body, req.model, usageRef),
      headers: { 'Content-Type': 'text/event-stream' },
      usageRef,
    };
  }

  private async *translateStream(
    stream: ReadableStream<Uint8Array>,
    model: string,
    usageRef?: { usage?: UsageInfo },
  ): AsyncGenerator<string> {
    let id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let finish: string | null = null;
    let started = false;
    // Anthropic 流式不产出 OpenAI 的 usage 分片，这里在转换过程中采集，
    // 供网关计费使用（cache 读写同样计入 prompt，口径与 OpenAI 一致）。
    let inputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let completion = 0;
    const publishUsage = () => {
      if (!usageRef) return;
      const prompt = inputTokens + cacheRead + cacheWrite;
      usageRef.usage = {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      };
    };

    for await (const ev of sseEvents(stream)) {
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (ev.event) {
        case 'message_start': {
          id = data.message?.id ?? id;
          started = true;
          const u = data.message?.usage ?? {};
          inputTokens = u.input_tokens ?? 0;
          cacheRead = u.cache_read_input_tokens ?? 0;
          cacheWrite = u.cache_creation_input_tokens ?? 0;
          if (typeof u.output_tokens === 'number') completion = u.output_tokens;
          yield chunkLine(id, data.message?.model ?? model, created, { role: 'assistant' }, null);
          break;
        }
        case 'content_block_delta': {
          const text = data.delta?.text;
          if (typeof text === 'string' && text.length > 0) {
            yield chunkLine(id, model, created, { content: text }, null);
          }
          break;
        }
        case 'message_delta': {
          if (data.delta?.stop_reason) finish = mapStopReason(data.delta.stop_reason);
          if (typeof data.usage?.output_tokens === 'number') {
            completion = data.usage.output_tokens;
          }
          break;
        }
        case 'message_stop': {
          if (!started) {
            yield chunkLine(id, model, created, { role: 'assistant' }, null);
          }
          yield chunkLine(id, model, created, {}, finish ?? 'stop');
          yield 'data: [DONE]\n\n';
          break;
        }
        default:
          break;
      }
    }
    // 兜底：上游未发 message_stop 也尽量给出已采集的用量
    if (usageRef && !usageRef.usage && (inputTokens || completion)) publishUsage();
  }
}
