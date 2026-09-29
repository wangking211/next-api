import { ApiKey, Channel, User } from '@prisma/client';
import { Request } from 'express';

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
