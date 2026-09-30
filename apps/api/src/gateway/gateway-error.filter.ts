import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { openaiError } from './types';
import { toAnthropicErrorBody } from './anthropic-format';

/** 状态码 → OpenAI 错误 type；未列出的 4xx 归 invalid_request_error，5xx 归 server_error */
export function openaiTypeFor(status: number): string {
  switch (status) {
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 429:
      return 'rate_limit_error';
    default:
      return status >= 500 ? 'server_error' : 'invalid_request_error';
  }
}

function exceptionMessage(exception: unknown): string {
  if (!(exception instanceof HttpException)) return '';
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const msg = (body as { message?: unknown }).message;
  if (Array.isArray(msg)) return msg.join(', '); // ValidationPipe 的字段错误数组
  if (typeof msg === 'string') return msg;
  return exception.message;
}

/**
 * 网关（/v1/**）异常 → 客户端协议的错误体。
 *
 * 在此之前只有控制器内显式 `res.status().json()` 的错误符合协议，而鉴权守卫、RPM/TPM
 * 限流、未预期异常都落到 Nest 默认处理器，返回 `{statusCode,message,error}`——OpenAI/Claude
 * SDK 取不到 `error.message`，客户端只会看到 "API error: undefined"。
 *
 * - `/v1/messages` → Anthropic 形状 `{type:'error', error:{type,message}}`
 * - 其余 `/v1/**` → OpenAI 形状 `{error:{message,type,code}}`
 * - 未预期异常对外给通用文案，堆栈只进日志（不泄露实现细节）
 */
@Catch()
export class GatewayErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(GatewayErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];

    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    let message = exceptionMessage(exception);
    if (!message) {
      message = 'The server had an error while processing your request.';
      this.logger.error(
        `未处理异常 ${req.method} ${path}: ${
          (exception as Error)?.stack ?? String(exception)
        }`,
      );
    }
    // 流式响应已开始写入时不能再改写错误体（客户端会在 SSE 流里看到中断）
    if (res.headersSent) return;

    const type = openaiTypeFor(status);
    if (path.startsWith('/v1/messages')) {
      res.status(status).json(toAnthropicErrorBody(message, type));
      return;
    }
    res.status(status).json(openaiError(message, type));
  }
}
