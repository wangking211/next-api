import { ApiKey, Channel, User } from '@prisma/client';
import { Request } from 'express';

export interface GatewayAuthContext {
  user: User;
  apiKey: ApiKey;
}

export interface GatewayRequest extends Request {
  gateway: GatewayAuthContext;
}

export interface ChatRequest {
  model: string;
  /** 原始 OpenAI 兼容请求体 */
  body: Record<string, any>;
  /** 上游请求超时（毫秒），默认 120000 */
  timeoutMs?: number;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
