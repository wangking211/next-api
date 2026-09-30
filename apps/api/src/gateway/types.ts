import { ApiKey, Channel, User } from '@prisma/client';
import { Request } from 'express';
import type { ChannelPricing } from '../billing/pricing.util';

export interface GatewayAuthContext {
  user: User;
  apiKey: ApiKey;
  /** TPM 预扣上下文（仅在 Key 配置了 TPM 上限且已预扣时存在） */
  tpm?: {
    /** 命中的固定窗口桶号（校正时定位同一桶） */
    bucket: number;
    /** 预估（预扣）的 token 数 */
    estimate: number;
    /** 实际用量（控制器回填；未回填视为 0，结算时全额回滚预估） */
    actual?: number;
    /** 是否已结算（防重复） */
    settled?: boolean;
  };
}

export interface GatewayRequest extends Request {
  gateway: GatewayAuthContext;
}

export interface ChatRequest {
  model: string;
  /** 原始 OpenAI 兼容请求体 */
  body: Record<string, any>;
  /** 上游请求超时（毫秒），默认 120000；传 0 表示不设总超时（由外部 signal/空闲超时控制） */
  timeoutMs?: number;
  /** 外部中止信号（如客户端断开时 abort 上游） */
  signal?: AbortSignal;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface NonStreamResult {
  status: number;
  json: any;
  usage?: UsageInfo;
  rawText?: string;
}

export interface StreamResult {
  status: number;
  /** 已转换为 OpenAI SSE 的文本块 */
  chunks: AsyncIterable<string>;
  headers?: Record<string, string>;
  /**
   * 流式过程中采集到的真实用量（可选）。上游不产出 usage 分片时，
   * provider 可在翻译过程中写入此处，网关优先采用它而不是估算值。
   */
  usageRef?: { usage?: UsageInfo };
}

export interface ResolvedChannel {
  channel: Channel;
  apiKey: string;
  /** 上游真实模型名（模型映射）；为空表示用请求的规范名 */
  upstreamModelName?: string | null;
  /**
   * 该渠道×模型的定价（resolve 时用已查出的渠道行 + 缓存目录行本地派生）。
   * 热路径的预授权 / 图片计价 / 落账直接复用，免再查 `getChannelPricing`。
   */
  pricing: ChannelPricing;
}

/** 视频任务查询（状态/内容）：只需上游任务 id */
export interface VideoTaskRequest {
  taskId: string;
  /** 上游超时（毫秒），默认 120000；传 0 表示不设（由外部 signal 控制） */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 视频内容（二进制流）：不缓冲整段视频，直接转发给客户端 */
export interface VideoContentResult {
  status: number;
  contentType: string;
  contentLength?: string;
  stream: ReadableStream<Uint8Array>;
}

export interface Provider {
  readonly name: string;
  readonly aliases?: string[];
  chatNonStream(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<NonStreamResult>;
  chatStream(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<StreamResult>;
  /**
   * 可选：`POST /v1/embeddings` 向量化透传（OpenAI 兼容协议）。未实现该方法的服务商
   * 在 embeddings 调用中会被跳过（如 Anthropic / Gemini 暂无兼容端点），全部候选
   * 都不支持时网关返回 501 而不是把请求打到上游报错。
   */
  embeddingsNonStream?(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<NonStreamResult>;
  /**
   * 可选：`POST /v1/images/generations` 图片生成透传（OpenAI 兼容协议）。
   * 与 embeddings 同款降级语义：未实现的服务商在图片调用中被跳过，
   * 全部候选都不支持时网关返回 501 而不是把请求打到上游报错。
   */
  imagesGenerate?(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<NonStreamResult>;
  /**
   * 可选：`POST /v1/videos` 视频生成任务透传（OpenAI 兼容异步任务协议，如豆包 Seedance）。
   * 与 embeddings/images 同款降级语义：未实现的服务商在视频调用中被跳过，
   * 全部候选都不支持时网关返回 501。
   */
  videosCreate?(
    channel: Channel,
    apiKey: string,
    req: ChatRequest,
  ): Promise<NonStreamResult>;
  /** 可选：`GET /v1/videos/{id}` 视频任务状态透传 */
  videoStatus?(
    channel: Channel,
    apiKey: string,
    req: VideoTaskRequest,
  ): Promise<NonStreamResult>;
  /** 可选：`GET /v1/videos/{id}/content` 视频内容透传（二进制流，不缓冲） */
  videoContent?(
    channel: Channel,
    apiKey: string,
    req: VideoTaskRequest,
  ): Promise<VideoContentResult>;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly body?: any,
  ) {
    super(message);
  }
}

export function openaiError(
  message: string,
  type = 'invalid_request_error',
  code: string | null = null,
): { error: { message: string; type: string; code: string | null } } {
  return { error: { message, type, code } };
}
