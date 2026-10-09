import { Channel } from '@prisma/client';
import {
  ChatRequest,
  NonStreamResult,
  Provider,
  StreamResult,
  UpstreamError,
  VideoContentResult,
  VideoTaskRequest,
} from '../types';
import { parseRetryAfterMs } from '../upstream-error.util';
import { joinUrl, pipeRaw, describeFetchError, combineSignals } from './stream.util';

/** 视频任务 id 只允许安全字符：防止路径穿越把请求打到上游的其它端点 */
const TASK_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function extractUsage(json: any) {
  const u = json?.usage;
  if (!u) return undefined;
  const prompt = u.prompt_tokens ?? 0;
  const completion = u.completion_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: u.total_tokens ?? prompt + completion,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/**
 * 识别「HTTP 200 但 body 是错误体」的载荷。
 *
 * 部分聚合/中转会这么干（实测 tokenfleet.cn 的 MiniMax-M2.5 返回
 * `{"code":401,"msg":"token 无效：sk-..."}`，且回包里带着上游 key）。
 * 若原样透传就会出现三件事同时发生：记为成功、照常扣费、把上游 key 回传给客户端。
 * 这里把它识别为上游故障 → 触发故障转移、不落账、且只回传网关自己的脱敏文案。
 *
 * 判定口径（保守）：先看有没有「正常载荷」特征字段，有就直接放行；
 * 否则要求出现 error 对象或「非成功 code」（New-API 风格 code=0/success 视为成功）。
 */
export function detectErrorPayload(json: any): { status: number; retryable: boolean } | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const hasPayload =
    Array.isArray(json.choices) ||
    Array.isArray(json.data) ||
    Array.isArray(json.embedding) ||
    json.output !== undefined ||
    typeof json.id === 'string' ||
    typeof json.object === 'string';
  if (hasPayload) return null;

  const errorObj = !!json.error && typeof json.error === 'object';
  const code = json.code ?? json.error?.code;
  const numeric = typeof code === 'number' ? code : Number.NaN;
  // 数字码落在 2xx/3xx 视为成功；其余约定：0 / 0 字符串 / success 也是成功
  const numericOk = numeric >= 200 && numeric < 400;
  const codeIsError =
    code != null &&
    !numericOk &&
    code !== 0 &&
    code !== '0' &&
    code !== 'success' &&
    code !== 'SUCCESS';
  if (!errorObj && !codeIsError) return null;

  const status = numeric >= 400 && numeric <= 599 ? numeric : 502;
  return { status, retryable: status >= 500 || status === 429 };
}

/**
 * OpenAI 兼容透传：覆盖 OpenAI / DeepSeek / Moonshot / Qwen / 智谱 / 自定义等。
 * 请求体与响应体均按 OpenAI 协议原样转发。
 */
export class OpenAiCompatibleProvider implements Provider {
  readonly name = 'openai';
  readonly aliases = [
    'openai',
    'deepseek',
    'moonshot',
    'qwen',
    'zhipu',
    'azure',
    'custom',
    'openai-compatible',
  ];

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
    return this.postJson(joinUrl(channel.baseUrl, 'chat/completions'), apiKey, req);
  }

  async embeddingsNonStream(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<NonStreamResult> {
    // OpenAI 兼容 /embeddings：请求体 {model, input, ...}，响应含 usage.prompt_tokens（无输出 token）
    return this.postJson(joinUrl(channel.baseUrl, 'embeddings'), apiKey, req);
  }

  async imagesGenerate(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<NonStreamResult> {
    // OpenAI 兼容 /images/generations：请求体 {model, prompt, n, size, quality, ...}
    return this.postJson(joinUrl(channel.baseUrl, 'images/generations'), apiKey, req);
  }

  async videosCreate(channel: Channel, apiKey: string, req: ChatRequest): Promise<NonStreamResult> {
    // OpenAI 兼容 /videos：请求体 {model, prompt, seconds|duration, image, metadata}
    return this.postJson(joinUrl(channel.baseUrl, 'videos'), apiKey, req);
  }

  async videoStatus(
    channel: Channel,
    apiKey: string,
    req: VideoTaskRequest,
  ): Promise<NonStreamResult> {
    return this.getJson(this.videoUrl(channel, req.taskId), apiKey, req);
  }

  async videoContent(
    channel: Channel,
    apiKey: string,
    req: VideoTaskRequest,
  ): Promise<VideoContentResult> {
    let res: Response;
    try {
      res = await fetch(`${this.videoUrl(channel, req.taskId)}/content`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        redirect: 'manual',
        signal: combineSignals(req.timeoutMs, req.signal),
      });
    } catch (e: any) {
      throw new UpstreamError(`Upstream connection failed: ${describeFetchError(e)}`, 502, true);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = {
          error: {
            message: text || 'Upstream returned no video content',
            type: 'upstream_error',
          },
        };
      }
      const status = res.status || 502;
      throw new UpstreamError(
        `Upstream error ${status}`,
        status,
        status >= 500 || status === 429,
        json,
        parseRetryAfterMs(res),
      );
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || 'video/mp4',
      contentLength: res.headers.get('content-length') ?? undefined,
      stream: res.body,
    };
  }

  /** 视频任务 URL（taskId 已校验字符集） */
  private videoUrl(channel: Channel, taskId: string): string {
    if (!TASK_ID_RE.test(taskId)) {
      throw new UpstreamError('Invalid video task id', 400, false);
    }
    return joinUrl(channel.baseUrl, `videos/${encodeURIComponent(taskId)}`);
  }

  /** 非流式 POST JSON 透传：chat / embeddings / images / videos 共用 */
  private async postJson(url: string, apiKey: string, req: ChatRequest): Promise<NonStreamResult> {
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
      throw new UpstreamError(`Upstream connection failed: ${describeFetchError(e)}`, 502, true);
    }
    return this.readJson(res);
  }

  /** GET JSON 透传（视频任务状态查询等） */
  private async getJson(
    url: string,
    apiKey: string,
    req: VideoTaskRequest,
  ): Promise<NonStreamResult> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        redirect: 'manual',
        signal: combineSignals(req.timeoutMs, req.signal),
      });
    } catch (e: any) {
      throw new UpstreamError(`Upstream connection failed: ${describeFetchError(e)}`, 502, true);
    }
    return this.readJson(res);
  }

  /** 统一解析 JSON 响应：非 2xx 与「200 + 错误体」都转成 UpstreamError */
  private async readJson(res: Response): Promise<NonStreamResult> {
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
    const bad = detectErrorPayload(json);
    if (bad) {
      throw new UpstreamError(
        'Upstream returned an error payload with HTTP 200',
        bad.status,
        bad.retryable,
        json,
      );
    }
    return { status: res.status, json, usage: extractUsage(json), rawText: text };
  }

  async chatStream(channel: Channel, apiKey: string, req: ChatRequest): Promise<StreamResult> {
    const url = joinUrl(channel.baseUrl, 'chat/completions');
    // 流式用量：上游默认不回 usage 分片，只能按字符数估算（中文低估 2~4 倍，
    // 直接影响扣费与分成）→ 显式请求 include_usage 拿真实用量；客户端自己指定了
    // stream_options 则以客户端为准。个别老兼容上游不认识该字段
    //（400 且报错提到 stream_options）→ 去掉重试一次，仍失败才按正常错误抛。
    const wantsUsage = req.body?.stream_options === undefined;
    const doFetch = (withUsage: boolean) =>
      fetch(url, {
        method: 'POST',
        headers: { ...this.headers(apiKey), Accept: 'text/event-stream' },
        body: JSON.stringify({
          ...req.body,
          stream: true,
          ...(withUsage ? { stream_options: { include_usage: true } } : {}),
        }),
        redirect: 'manual',
        signal: combineSignals(req.timeoutMs, req.signal),
      });
    let res: Response;
    try {
      res = await doFetch(wantsUsage);
      if (wantsUsage && res.status === 400) {
        const probe = await res.clone().text();
        if (/stream_options/i.test(probe)) res = await doFetch(false);
      }
    } catch (e: any) {
      throw new UpstreamError(`Upstream connection failed: ${describeFetchError(e)}`, 502, true);
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
      throw new UpstreamError(
        `Upstream error ${res.status}`,
        res.status,
        retryable,
        json,
        parseRetryAfterMs(res),
      );
    }

    // 流式请求却回了 JSON：多半是「200 + 错误体」的中转；识别出来就转成上游故障，
    // 否则原样透传（保持旧行为，避免吞掉非标准上游的正常返回）。
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON：按原样透传 */
      }
      const bad = json ? detectErrorPayload(json) : null;
      if (bad) {
        throw new UpstreamError(
          'Upstream returned an error payload with HTTP 200',
          bad.status,
          bad.retryable,
          json,
        );
      }
      return {
        status: 200,
        chunks: (async function* () {
          yield text;
        })(),
        headers: { 'Content-Type': 'application/json' },
      };
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
