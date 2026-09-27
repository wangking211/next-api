import { Channel } from '@prisma/client';
import {
  ChatRequest,
  NonStreamResult,
  Provider,
  StreamResult,
  UpstreamError,
} from '../types';
import { joinUrl, pipeRaw, describeFetchError, combineSignals } from './stream.util';

function extractUsage(json: any) {
  const u = json?.usage;
  if (!u) return undefined;
  const prompt = u.prompt_tokens ?? 0;
  const completion = u.completion_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: u.total_tokens ?? prompt + completion,
  };
}

/**
 * OpenAI 兼容透传：覆盖 OpenAI / DeepSeek / Moonshot / Qwen / 智谱 / 自定义等。
 * 请求体与响应体均按 OpenAI 协议原样转发。
 */
export class OpenAiCompatibleProvider implements Provider {
  readonly name = 'openai';
  readonly aliases = ['openai', 'deepseek', 'moonshot', 'qwen', 'zhipu', 'azure', 'custom', 'openai-compatible'];

  private headers(apiKey: string) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  async chatNonStream(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<NonStreamResult> {
    const url = joinUrl(channel.baseUrl, 'chat/completions');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.headers(apiKey),
        body: JSON.stringify(req.body),
        redirect: 'manual',
        signal: combineSignals(req.timeoutMs, req.signal),
      });
    } catch (e: any) {
      throw new UpstreamError(
        `Upstream connection failed: ${describeFetchError(e)}`,
        502,
        true,
      );
    }

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
    return { status: res.status, json, usage: extractUsage(json), rawText: text };
  }

  async chatStream(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<StreamResult> {
    const url = joinUrl(channel.baseUrl, 'chat/completions');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...this.headers(apiKey), Accept: 'text/event-stream' },
        body: JSON.stringify({ ...req.body, stream: true }),
        redirect: 'manual',
        signal: combineSignals(req.timeoutMs, req.signal),
      });
    } catch (e: any) {
      throw new UpstreamError(
        `Upstream connection failed: ${describeFetchError(e)}`,
        502,
        true,
      );
    }

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
    return {
      status: 200,
      chunks: pipeRaw(res.body),
      headers: { 'Content-Type': 'text/event-stream' },
    };
  }
}
