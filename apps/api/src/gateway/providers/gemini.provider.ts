import { Channel } from '@prisma/client';
import {
  ChatRequest,
  NonStreamResult,
  Provider,
  StreamResult,
  UpstreamError,
  UsageInfo,
} from '../types';
import { joinUrl, sseEvents, describeFetchError, combineSignals } from './stream.util';

function toGeminiParts(content: any): any[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content ?? '') }];
  const parts: any[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ text: part });
      continue;
    }
    if (part?.type === 'text') {
      parts.push({ text: part.text });
    } else if (part?.type === 'image_url') {
      const url: string = part.image_url?.url ?? '';
      const m = /^data:(.+?);base64,(.*)$/.exec(url);
      if (m) {
        parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      } else if (url) {
        parts.push({ fileData: { fileUri: url } });
      }
    } else {
      parts.push({ text: JSON.stringify(part) });
    }
  }
  return parts;
}

export function buildGeminiBody(req: ChatRequest): Record<string, any> {
  const body = req.body;
  const systemParts: any[] = [];
  const contents: any[] = [];
  for (const m of body.messages ?? []) {
    const parts = toGeminiParts(m.content);
    if (m.role === 'system') {
      systemParts.push(...parts);
      continue;
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }

  const out: Record<string, any> = { contents };
  if (systemParts.length) out.systemInstruction = { parts: systemParts };

  const cfg: Record<string, any> = {};
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens != null) cfg.maxOutputTokens = maxTokens;
  if (body.temperature != null) cfg.temperature = body.temperature;
  if (body.top_p != null) cfg.topP = body.top_p;
  if (body.stop != null) {
    cfg.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  if (Object.keys(cfg).length) out.generationConfig = cfg;
  return out;
}

function mapFinish(reason?: string | null): string {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function textOf(gem: any): string {
  const parts = gem?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p: any) => typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('');
}

function usageOf(gem: any) {
  const u = gem?.usageMetadata;
  if (!u) return undefined;
  const prompt = u.promptTokenCount ?? 0;
  const completion = u.candidatesTokenCount ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: u.totalTokenCount ?? prompt + completion,
    cacheReadTokens: u.cachedContentTokenCount ?? 0,
  };
}

export function toOpenAiResponse(gem: any, model: string) {
  const usage = usageOf(gem) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: gem?.modelVersion ?? model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: textOf(gem) },
        finish_reason: mapFinish(gem?.candidates?.[0]?.finishReason),
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
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
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  readonly aliases = ['gemini', 'google', 'googleai', 'google-ai'];

  private headers(apiKey: string) {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    };
  }

  private async request(
    channel: Channel,
    apiKey: string,
    model: string,
    body: Record<string, any>,
    stream: boolean,
    timeoutMs = 120000,
    signal?: AbortSignal,
  ): Promise<Response> {
    const path = `models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    const url = joinUrl(channel.baseUrl, path);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: this.headers(apiKey),
        body: JSON.stringify(body),
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
      req.model,
      buildGeminiBody(req),
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
      throw new UpstreamError(`Upstream error ${res.status}`, res.status, retryable, json);
    }
    const openai = toOpenAiResponse(json, req.model);
    return {
      status: 200,
      json: openai,
      usage: {
        promptTokens: openai.usage.prompt_tokens,
        completionTokens: openai.usage.completion_tokens,
        totalTokens: openai.usage.total_tokens,
        cacheReadTokens: usageOf(json)?.cacheReadTokens ?? 0,
      },
      rawText: JSON.stringify(openai),
    };
  }

  async chatStream(channel: Channel, apiKey: string, req: ChatRequest): Promise<StreamResult> {
    const res = await this.request(
      channel,
      apiKey,
      req.model,
      buildGeminiBody(req),
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
      throw new UpstreamError(`Upstream error ${res.status}`, res.status, retryable, json);
    }
    if (!res.body) {
      throw new UpstreamError('Upstream returned empty stream', 502, true);
    }
    // 流式真实用量：Gemini 每个分片都可能带 usageMetadata（末片最全），
    // 采集进 usageRef，否则只能按字符估算（中文低估 2~4 倍）
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
    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let roleSent = false;
    let finish = 'stop';
    let captured: UsageInfo | undefined;

    for await (const ev of sseEvents(stream)) {
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      // 用量随分片累积，最后一个带 usageMetadata 的分片最完整 → 覆盖式采集
      const u = usageOf(data);
      if (u) captured = u;
      const candidate = data?.candidates?.[0];
      if (!roleSent) {
        yield chunkLine(id, data?.modelVersion ?? model, created, { role: 'assistant' }, null);
        roleSent = true;
      }
      const parts = candidate?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text.length > 0) {
          yield chunkLine(id, data?.modelVersion ?? model, created, { content: p.text }, null);
        }
      }
      if (candidate?.finishReason) finish = mapFinish(candidate.finishReason);
    }

    if (usageRef && captured) usageRef.usage = captured;
    if (!roleSent) {
      yield chunkLine(id, model, created, { role: 'assistant' }, null);
    }
    yield chunkLine(id, model, created, {}, finish);
    yield 'data: [DONE]\n\n';
  }
}
